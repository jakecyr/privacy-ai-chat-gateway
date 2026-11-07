import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createProductionServer} from '../production-server.js';
function dependencies(appCheck) {
 const forbidden=()=>{assert.fail('connection check reached chat, billing or quota dependencies')};
 return {appCheck,allowedAppIDs:['release-app'],configuration:forbidden,quota:{take:forbidden},generate:forbidden,validateVoucher:forbidden,spendVoucher:forbidden};
}
async function start(t,appCheck,options={}) {
 const server=createProductionServer({...dependencies(appCheck),...options});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections();server.close()});
 return (token,body='{}',headers={})=>fetch(`http://127.0.0.1:${server.address().port}/v1/attestation/check`,{method:'POST',headers:{'Content-Type':'application/json','X-Firebase-AppCheck':token,...headers},body});
}
test('connection check consumes attestation once without any content or credit dependency',async t=>{
 const consumed=new Set();const post=await start(t,{verifyToken:async(token,options)=>{
  assert.deepEqual(options,{consume:true});const alreadyConsumed=consumed.has(token);consumed.add(token);return {appId:'release-app',alreadyConsumed};
 }});
 const first=await post('synthetic-release-token');assert.equal(first.status,200);assert.deepEqual(await first.json(),{verified:true});assert.equal(first.headers.get('cache-control'),'no-store');
 const replay=await post('synthetic-release-token');assert.equal(replay.status,401);assert.deepEqual(await replay.json(),{error:'attestation_invalid'});
 for(const body of ['{"messages":[]}','{"signedTransaction":"synthetic"}','[]','null','{"memory":[]}'])assert.equal((await post('new-'+body,body)).status,400);
 assert.equal((await post('oversized',' '.repeat(257))).status,413);
 assert.equal((await post('compressed','{}',{'Content-Encoding':'gzip'})).status,415);
});
test('connection check rejects wrong app, verifier failure and a stalled verifier',async t=>{
 const post=await start(t,{verifyToken:async token=>{
  if(token==='stalled')return new Promise(()=>{});
  if(token==='invalid')throw new Error('PRIVATE_PROVIDER_ERROR');
  return {appId:'another-project-app'};
 }},{deadlineMS:100});
 for(const token of ['wrong-app','invalid']) {
  const result=await post(token);assert.equal(result.status,401);assert.deepEqual(await result.json(),{error:'attestation_invalid'});
 }
 const stalled=await post('stalled');assert.equal(stalled.status,503);assert.deepEqual(await stalled.json(),{error:'upstream_timeout'});
});

test('explicit attestation-only mode cannot advertise or invoke an inference route',async t=>{
 const {createAttestationOnlyServer}=await import('../production-server.js');
 let verifications=0;
 const server=createAttestationOnlyServer({appCheck:{verifyToken:async()=>{verifications++;return {appId:'release-app'}}},allowedAppIDs:['release-app']});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close()});
 const origin=`http://127.0.0.1:${server.address().port}`;
 const models=await fetch(origin+'/v1/models');assert.deepEqual(await models.json(),{version:1,routes:[]});
 const chat=await fetch(origin+'/v1/chat/stream',{method:'POST',headers:{'Content-Type':'application/json','X-Firebase-AppCheck':'synthetic'},body:JSON.stringify({route:'openai-terra-text',disclosureVersion:1,messages:[{role:'user',text:'synthetic'}],memory:[]})});
 assert.equal(chat.status,503);assert.deepEqual(await chat.json(),{error:'route_unavailable'});
 const check=await fetch(origin+'/v1/attestation/check',{method:'POST',headers:{'Content-Type':'application/json','X-Firebase-AppCheck':'another-synthetic'},body:'{}'});
 assert.equal(check.status,200);assert.deepEqual(await check.json(),{verified:true});assert.equal(verifications,2);
});

test('attestation-only runtime boots without provider, voucher or database configuration',{timeout:5000},async t=>{
 const {spawn}=await import('node:child_process');const {createServer}=await import('node:net');
 const {setTimeout:delay}=await import('node:timers/promises');
 const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
 const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const child=spawn(process.execPath,['runtime.js'],{cwd:new URL('..',import.meta.url),env:{PATH:process.env.PATH,GOOGLE_CLOUD_PROJECT:'demo-attestation-check',APP_CHECK_APP_IDS:'["release-app"]',PORT:String(port),ATTESTATION_CHECK_ONLY:'true',OPENAI_KEY_FILE:'/nonexistent-provider-key',VOUCHER_PUBLIC_KEYS_FILE:'/nonexistent-voucher-keys'},stdio:'ignore'});
 t.after(()=>child.kill('SIGKILL'));
 let ready=false;
 for(let attempt=0;attempt<60;attempt++) {
  assert.equal(child.exitCode,null,'attestation-only runtime exited before listening');
  try {const result=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(200)});if(result.status===200){ready=true;break}}catch{}
  await delay(50);
 }
 assert.equal(ready,true);
 const models=await fetch(`http://127.0.0.1:${port}/v1/models`);assert.deepEqual(await models.json(),{version:1,routes:[]});
});
