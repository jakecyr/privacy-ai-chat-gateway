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
