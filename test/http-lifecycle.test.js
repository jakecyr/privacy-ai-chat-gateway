import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import http from 'node:http';
import {createProductionServer} from '../production-server.js';
import {createBillingServer} from '../billing-server.js';
import {GatewayError} from '../admission.js';

const route={id:'openai-terra-text',provider:'OpenAI',model:'gpt-5.6-terra',disclosureVersion:1,enabled:true,retentionProfile:'zdr',verifiedUntil:Date.now()+3600000,targetDigest:'a'.repeat(64),verification:{evidenceDigest:'b'.repeat(64),reviewedAt:Date.now(),agreementApproved:true,payloadVerified:true,cacheDisabled:true,loggingDisabled:true,abuseMonitoringApproved:true,persistentUserIDNotRequired:true,pricingVerified:true}};
const body={route:route.id,disclosureVersion:1,messages:[{role:'user',text:'SYNTHETIC_PRIVATE_INPUT'}],memory:[]};
const defaults=()=>({appCheck:{verifyToken:async()=>({appId:'app'})},allowedAppIDs:['app'],configuration:async()=>({enabled:true,version:1,fetchedAt:Date.now(),routes:[route]}),quota:{take:async()=>{}},validateVoucher:async()=>{},spendVoucher:async()=>{},generate:async function*(){yield {type:'done',reason:'stop'}}});
async function listen(server,t) {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  return `http://127.0.0.1:${server.address().port}`;
}
const post=(origin,value=body,path='/v1/chat/stream')=>fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json','X-Firebase-AppCheck':'synthetic',Authorization:'Bearer synthetic'},body:JSON.stringify(value),signal:AbortSignal.timeout(2000)});

test('attestation deadline ends HTTP and late verifier cannot admit a provider attempt',async t=>{
  let release,calls=0,credits=0;
  const pending=new Promise(resolve=>release=resolve);
  const server=createProductionServer({...defaults(),deadlineMS:200,appCheck:{verifyToken:()=>pending},quota:{take:async()=>{credits++}},generate:async function*(){calls++;yield {type:'done',reason:'stop'}}});
  const response=await post(await listen(server,t));
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{error:'upstream_timeout'});
  release({appId:'app'});await setImmediate();
  assert.equal(calls,0);assert.equal(credits,0);
});

test('stalled provider emits one safe terminal error and is cancelled at deadline',async t=>{
  let cancelled=false,returned=0;
  const server=createProductionServer({...defaults(),deadlineMS:200,generate:(_route,_body,signal)=>{
    signal.addEventListener('abort',()=>cancelled=true,{once:true});
    return {[Symbol.asyncIterator](){return this},next:()=>new Promise(()=>{}),return:async()=>{returned++;return {done:true}}};
  }});
  const response=await post(await listen(server,t));assert.equal(response.status,200);
  const stream=await response.text();
  assert.match(stream,/event: meta/);
  assert.equal((stream.match(/event: error/g)||[]).length,1);
  assert.match(stream,/upstream_timeout/);assert.doesNotMatch(stream,/SYNTHETIC_PRIVATE_INPUT/);
  await setImmediate();assert.equal(cancelled,true);assert.equal(returned,1);
});

test('client disconnect promptly cancels the provider without another attempt',async t=>{
  let cancel,attempts=0;
  const cancelled=new Promise(resolve=>cancel=resolve);
  const server=createProductionServer({...defaults(),deadlineMS:3000,generate:(_route,_body,signal)=>{
    attempts++;signal.addEventListener('abort',cancel,{once:true});
    return {[Symbol.asyncIterator](){return this},next:()=>new Promise(()=>{}),return:async()=>({done:true})};
  }});
  const origin=await listen(server,t);
  const request=http.request(origin+'/v1/chat/stream',{method:'POST',headers:{'Content-Type':'application/json','X-Firebase-AppCheck':'synthetic',Authorization:'Bearer synthetic'}},response=>{
    response.once('data',()=>request.destroy());response.on('error',()=>{});
  });
  request.on('error',()=>{});request.end(JSON.stringify(body));
  let timer;
  try {await Promise.race([cancelled,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('disconnect was not propagated')),1500)})]);}
  finally {clearTimeout(timer);request.destroy();}
  assert.equal(attempts,1);
});

test('large escaped and multibyte provider deltas fit the client SSE line bound',async t=>{
  const text='\u0001'.repeat(5000)+'🌱'.repeat(2000);
  const server=createProductionServer({...defaults(),generate:async function*(){yield {type:'delta',text};yield {type:'done',reason:'stop'}}});
  const response=await post(await listen(server,t));const wire=await response.text();
  const frames=wire.split('\n\n').filter(frame=>frame.startsWith('event: delta'));
  assert.ok(frames.length>1);
  const reconstructed=frames.map(frame=>{
    const line=frame.split('\n')[1];assert.ok(Buffer.byteLength(line)<16384);
    return JSON.parse(line.slice(6)).text;
  }).join('');
  assert.equal(reconstructed,text);
  assert.equal((wire.match(/event: done/g)||[]).length,1);
});

test('billing dependency deadline returns safe failure without waiting for late issuance',async t=>{
  let issueCalls=0,release;
  const pending=new Promise(resolve=>release=resolve);
  const server=createBillingServer({appCheck:defaults().appCheck,allowedAppIDs:['app'],deadlineMS:200,issue:async()=>{issueCalls++;return pending}});
  const response=await post(await listen(server,t),{signedTransaction:'PRIVATE_JWS',route:route.id,count:1},'/v1/access/issue');
  assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'upstream_timeout'});
  assert.equal(issueCalls,1);release([]);await setImmediate();
});

test('Apple notifications bypass app attestation but require strict signed-only payload',async t=>{
  let verifies=0;
  const server=createBillingServer({appCheck:{verifyToken:async()=>assert.fail('Apple does not supply app token')},allowedAppIDs:['app'],issue:async()=>assert.fail('never issue from notification'),notify:async signed=>{verifies++;if(signed==='bad')throw new GatewayError(400,'notification_invalid')}});
  const origin=await listen(server,t);
  assert.equal((await post(origin,{signedPayload:'valid',messages:[]},'/v1/apple/notifications')).status,400);
  const invalid=await post(origin,{signedPayload:'bad'},'/v1/apple/notifications');assert.equal(invalid.status,400);assert.deepEqual(await invalid.json(),{error:'notification_invalid'});
  assert.equal((await post(origin,{signedPayload:'valid'},'/v1/apple/notifications')).status,200);
  assert.equal(verifies,2);
});

test('model token limit rejects a wire-valid request before quota, voucher spending or generation',async t=>{
  let quota=0,spent=0,generated=0;
  const server=createProductionServer({...defaults(),quota:{take:async()=>quota++},spendVoucher:async()=>spent++,generate:async function*(){generated++;yield {type:'done',reason:'stop'}}});
  const value={...body,messages:[{role:'user',text:'\x7f'.repeat(32500)}]};
  assert.ok(Buffer.byteLength(JSON.stringify(value))<32768);
  const response=await post(await listen(server,t),value);
  assert.equal(response.status,413);assert.deepEqual(await response.json(),{error:'input_limit'});
  assert.equal(quota,0);assert.equal(spent,0);assert.equal(generated,0);
});
