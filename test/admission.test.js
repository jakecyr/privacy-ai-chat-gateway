import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DailyQuota, activeRoute, publicModels, cachedConfiguration, verifyAttestation, GatewayError } from '../admission.js';
import { createProductionServer } from '../production-server.js';
const route = {id:'openai-terra-text',provider:'OpenAI',model:'gpt-5.6-terra',disclosureVersion:1,enabled:true,retentionProfile:'zdr',verifiedUntil:Date.now()+3600000,targetDigest:'a'.repeat(64),verification:{evidenceDigest:'b'.repeat(64),reviewedAt:Date.now(),agreementApproved:true,payloadVerified:true,cacheDisabled:true,loggingDisabled:true,abuseMonitoringApproved:true,persistentUserIDNotRequired:true,pricingVerified:true}};
test('route evidence expires and stale configuration fails closed', () => {
 const now = Date.now(); const config = {enabled:true,fetchedAt:now,routes:[route]};
 assert.equal(activeRoute(config,route.id,now).id,route.id);
 assert.throws(() => activeRoute({...config,fetchedAt:now-15001},route.id,now));
 assert.throws(() => activeRoute({...config,routes:[{...route,verifiedUntil:now}]},route.id,now));
 assert.throws(() => activeRoute({...config,enabled:false},route.id,now));
});
test('public discovery projects only eligible public fields and honors shutdown',()=>{
 const now=Date.now();
 const config={version:3,enabled:true,fetchedAt:now,routes:[{...route,privateEvidence:'PRIVATE_PROJECT'}, {...route,id:'expired',verifiedUntil:now}]};
 assert.deepEqual(publicModels(config,now),{version:3,routes:[{id:route.id,provider:'OpenAI',model:'gpt-5.6-terra',disclosureVersion:1}]});
 assert.deepEqual(publicModels({...config,enabled:false},now),{version:3,routes:[]});
 assert.throws(()=>publicModels({...config,fetchedAt:now-15001},now));
});
test('configuration refresh coalesces requests and never uses stale data on dependency failure',async()=>{
 let time=1000,calls=0,fail=false;
 const configuration=cachedConfiguration(async()=>{calls++;if(fail)throw new Error('PRIVATE_ERROR');return {version:1};},{now:()=>time});
 const results=await Promise.all(Array.from({length:20},()=>configuration()));
 assert.equal(calls,1);assert.ok(results.every(x=>x.fetchedAt===1000));
 time=15999;await configuration();assert.equal(calls,1);
 time=16000;fail=true;await assert.rejects(configuration(),{message:'route_unavailable'});
 fail=false;const fresh=await configuration();assert.equal(fresh.fetchedAt,16000);assert.equal(calls,3);
 time=15999;await configuration();assert.equal(calls,4);
});
test('App Check consumes token and rejects replay and other apps', async () => {
 let options;
 await verifyAttestation({verifyToken:async (_,o) => {options=o;return {appId:'allowed'};}},'token',['allowed']);
 assert.deepEqual(options,{consume:true});
 for (const claims of [{appId:'other'},{appId:'allowed',alreadyConsumed:true}]) await assert.rejects(verifyAttestation({verifyToken:async () => claims},'token',['allowed']));
});
test('concurrent allocator never exceeds fleet limit and discards old credits', async () => {
 let used = 0; let date = new Date('2026-11-07T23:59:59Z');
 const quota = new DailyQuota({dailyLimit:17,now:()=>date,reserve:async (_,batch,limit) => { const n=Math.min(batch,limit-used); used+=n; return n; }});
 const results = await Promise.allSettled(Array.from({length:40},()=>quota.take()));
 assert.equal(results.filter(x=>x.status==='fulfilled').length,17); assert.equal(used,17);
 date = new Date('2026-11-08T00:00:01Z'); used=0; await quota.take(); assert.equal(used,8);
 date = new Date('2026-11-07T00:00:00Z'); await assert.rejects(quota.take());
});
test('production rejection paths make zero provider calls and never echo errors', async t => {
 let calls = 0,credits=0;
 const server = createProductionServer({appCheck:{verifyToken:async token => {if(token==='bad') throw new Error('SECRET'); return {appId:'allowed'};}},allowedAppIDs:['allowed'],configuration:async()=>({enabled:true,fetchedAt:Date.now(),routes:[route]}),quota:{take:async()=>{credits++}},validateVoucher:async token=>{if(token!=='voucher')throw new GatewayError(401,'access_invalid')},spendVoucher:async()=>{},generate:async function*(){calls++;yield {type:'done',reason:'stop'};}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r)); t.after(()=>server.close());
 const url=`http://127.0.0.1:${server.address().port}/v1/chat/stream`;
 const body={route:route.id,disclosureVersion:1,messages:[{role:'user',text:'synthetic'}],memory:[]};
 for(const [token,payload,authorization,status] of [['bad',body,'Bearer voucher',401],['good',{...body,transactionId:'forbidden'},'Bearer voucher',400],['good',{...body,route:'https://arbitrary-destination'},'Bearer voucher',400],['good',{...body,disclosureVersion:0},'Bearer voucher',400],['good',{...body,disclosureVersion:2},'Bearer voucher',409],['good',body,'',401],['good',body,'Bearer forged',401]]) {
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Firebase-AppCheck':token,Authorization:authorization},body:JSON.stringify(payload)});
  assert.equal(response.status,status);assert.doesNotMatch(await response.text(),/SECRET|synthetic|forbidden/);
 }
 assert.equal(calls,0);
 assert.equal(credits,0);
 const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Firebase-AppCheck':'good',Authorization:'Bearer voucher'},body:JSON.stringify(body)});
 assert.equal(response.status,200);assert.match(await response.text(),/event: done/);assert.equal(calls,1);
});
