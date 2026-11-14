import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {access,mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {firestoreAttestationVerifier,verifyAttestation} from '../admission.js';
import {createBillingServer} from '../billing-server.js';
import {routeSpecification} from '../route-specs.js';
import {createChatServer} from '../production-server.js';

let infrastructure=new URL('../infrastructure/',import.meta.url);
try {await access(new URL('model-catalog.json',infrastructure));}
catch(error) {
 if(error.code!=='ENOENT')throw error;
 infrastructure=new URL('../../infrastructure/',import.meta.url);
}
const catalogPath=new URL('model-catalog.json',infrastructure);
const pricesPath=new URL('model-pricing.json',infrastructure);
const renderer=new URL('../render-model-routes.mjs',import.meta.url);

test('standard routes include Sol and Luna with their own prices and reasoning levels',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'private-chat-models-'));
 try {
  const output=join(directory,'routes.json');
  execFileSync(process.execPath,[fileURLToPath(renderer),fileURLToPath(catalogPath),fileURLToPath(pricesPath),output,'--standard-openai']);
  const config=JSON.parse(await readFile(output));
  assert.equal(config.routes.length,17);
  assert.deepEqual([...new Set(config.routes.map(route=>route.model))],['gpt-6.1-terra','gpt-6.1-sol','gpt-6-luna']);
  for(const route of config.routes) {
   const spec=routeSpecification(route.id,route);
   assert.ok(spec);
   assert.ok(config.issuerPolicy.routeCosts[route.id]>=spec.minimumReservationMicroUSD);
   assert.equal(route.inputMicroUSDPerToken,{'gpt-6.1-terra':1,'gpt-6.1-sol':2,'gpt-6-luna':0.1}[route.model]);
   assert.equal(route.enabled,false);
  }
  assert.equal(config.routes.filter(route=>route.model==='gpt-6.1-sol').length,5);
  const sol=config.routes.find(route=>route.model==='gpt-6.1-sol');
  assert.equal(routeSpecification(sol.id,{...sol,reasoning:'none'}),undefined);
 } finally {await rm(directory,{recursive:true,force:true});}
});

test('fresh verified tokens are admitted once even when Firebase omits replay state',async()=>{
 const documents=new Map();
 const database={collection(name){assert.equal(name,'appCheckTokens');return {doc(id){return {async create(value){
  if(documents.has(id))throw Object.assign(new Error('duplicate'),{code:6});
  documents.set(id,value);
 }}}}}};
 const source={verifyToken:async(_token,options)=>{assert.deepEqual(options,{consume:true});return {appId:'app'};}};
 const guarded=firestoreAttestationVerifier(source,database,['app']);
 const results=await Promise.allSettled(Array.from({length:4},()=>verifyAttestation(guarded,'synthetic-secret-token',['app'])));
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
 assert.ok(results.filter(result=>result.status==='rejected').every(result=>result.reason.code==='attestation_invalid'));
 assert.deepEqual([...documents.keys()],[createHash('sha256').update('synthetic-secret-token').digest('hex')]);
 assert.ok([...documents.values()][0].expiresAt instanceof Date);
});

test('attestation infrastructure failures are reported as service failures before billing',async()=>{
 const appCheck={verifyToken:async()=>{throw Object.assign(new Error('private configuration'),{code:'app-check/permission-denied'});}};
 await assert.rejects(verifyAttestation(appCheck,'token',['app']),error=>error.status===503 && error.code==='attestation_unavailable');
 const guarded=firestoreAttestationVerifier({verifyToken:async()=>({appId:'app'})},{collection(){throw new Error('private database');}},['app']);
 await assert.rejects(verifyAttestation(guarded,'token',['app']),error=>error.status===503 && error.code==='attestation_unavailable');
});

test('older clients receive compatible policy routes while modern clients get Sol and Luna',async t=>{
 const routes=[
  {id:'terra',provider:'OpenAI',model:'gpt-6.1-terra',profile:'text-openai-standard-v1'},
  {id:'sol',provider:'OpenAI',model:'gpt-6.1-sol',profile:'text-openai-standard-v1'},
  {id:'luna',provider:'OpenAI',model:'gpt-6-luna',profile:'text-openai-standard-v1'}
 ];
 const server=createBillingServer({appCheck:{verifyToken:async()=>({appId:'app'})},allowedAppIDs:['app'],policy:{version:1,routes},issue:async()=>{throw new Error('Must not reserve allowance');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections();server.close();});
 const origin=`http://127.0.0.1:${server.address().port}`;
 const legacy=await fetch(origin+'/v1/access/policy');
 const legacyTag=legacy.headers.get('etag');
 assert.deepEqual((await legacy.json()).routes,[routes[0]]);
 const modern=await fetch(origin+'/v1/access/policy',{headers:{'X-PrivateChat-Model-Policy':'2'}});
 assert.deepEqual((await modern.json()).routes,routes);
 assert.notEqual(modern.headers.get('etag'),legacyTag);
 const denied=await fetch(origin+'/v1/access/issue',{method:'POST',headers:{'Content-Type':'application/json','X-Firebase-AppCheck':'token','If-Match':legacyTag},body:JSON.stringify({route:'sol',count:1,signedTransaction:'synthetic'})});
 assert.equal(denied.status,400);
 const mismatched=await fetch(origin+'/v1/access/issue',{method:'POST',headers:{'Content-Type':'application/json','X-Firebase-AppCheck':'token','X-PrivateChat-Model-Policy':'2','If-Match':legacyTag},body:JSON.stringify({route:'sol',count:1,signedTransaction:'synthetic'})});
 assert.equal(mismatched.status,412);
});

test('gateway discovery keeps old clients compatible and advertises new models to capable clients',async t=>{
 const routes=['gpt-6.1-terra','gpt-6.1-sol','gpt-6-luna'].map((model,index)=>({id:'route-'+index,provider:'OpenAI',model,profile:'text-openai-standard-v1',disclosureVersion:3,reasoning:'low',label:model}));
 const server=createChatServer({appCheck:{},allowedAppIDs:['app'],configuration:async()=>({version:2,fetchedAt:Date.now(),routes}),resolveRoute:(config,id)=>config.routes.find(route=>route.id===id),generate:async function*(){assert.fail('Discovery must not generate');},admit:async()=>assert.fail('Discovery must not reserve usage')});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections();server.close();});
 const url=`http://127.0.0.1:${server.address().port}/v1/models`;
 assert.deepEqual((await (await fetch(url)).json()).routes.map(route=>route.model),['gpt-6.1-terra']);
 assert.deepEqual((await (await fetch(url,{headers:{'X-PrivateChat-Model-Policy':'2'}})).json()).routes.map(route=>route.model),routes.map(route=>route.model));
});
