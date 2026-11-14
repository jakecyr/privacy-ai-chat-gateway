import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {activeRoute} from '../admission.js';
import {createOpenAIBetaServer,openAIBetaRoutes} from '../openai-beta.js';
import {routeSpecification} from '../route-specs.js';

const route=openAIBetaRoutes[0];

function fixture({reservedMicroUSD=0}={}) {
  const data={reservedMicroUSD};
  const documents=new Map([['generationQuotas/openai-testflight-v1',data]]);
  const database={
    collection:collection=>({doc:id=>{
      const path=collection+'/'+id;
      return {path,get:async()=>({exists:documents.has(path),data:()=>documents.get(path)})};
    }}),
    runTransaction:async operation=>operation({
      get:ref=>ref.get(),
      set:(ref,values)=>{
        if(documents.has(ref.path)) Object.assign(documents.get(ref.path),values);
        else documents.set(ref.path,values);
      },
    }),
  };
  const appCheck={verifyToken:async (token,{consume})=>{
    assert.equal(consume,true);
    if(!token.startsWith('fixture-')) throw new Error('invalid');
    return {appId:'fixture-app',alreadyConsumed:false};
  }};
  let calls=0;
  const fetchImpl=async (url,{body})=>{
    calls++;
    const payload=JSON.parse(body);
    assert.equal(url,'https://api.openai.com/v1/responses');
    assert.equal(payload.model,route.model);
    assert.equal(payload.store,false);
    assert.equal(payload.reasoning.effort,route.reasoning);
    assert.deepEqual(payload.prompt_cache_options,{mode:'explicit'});
    const events=[
      {type:'response.created',response:{model:route.model}},
      {type:'response.output_text.delta',delta:'Synthetic reply'},
      {type:'response.completed',response:{model:route.model,usage:{input_tokens:20,output_tokens:2,total_tokens:22,
        input_tokens_details:{cached_tokens:0,cache_write_tokens:0},output_tokens_details:{reasoning_tokens:0}}}},
    ];
    return new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
  };
  const server=createOpenAIBetaServer({appCheck,allowedAppIDs:['fixture-app'],database,apiKey:'fixture-key',expiresAt:Date.now()+60000,fetchImpl});
  return {server,data,calls:()=>calls};
}

async function start(t,server) {
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return 'http://127.0.0.1:'+server.address().port;
}

function send(origin,token,version=2,id=route.id) {
  return fetch(origin+'/v1/chat/stream',{method:'POST',headers:{'Content-Type':'application/json',...(token?{'X-Firebase-AppCheck':token}:{})},
    body:JSON.stringify({route:id,disclosureVersion:version,messages:[{role:'user',text:'Synthetic prompt'}],memory:[]})});
}

test('beta publishes only OpenAI, requires fresh app attestation and consent version, then streams without a purchase voucher',async t=>{
  const {server,data,calls}=fixture();
  const origin=await start(t,server);
  const listed=await fetch(origin+'/v1/models');
  assert.equal(listed.headers.get('X-PrivateChat-Beta-Usage'),'100');
  const catalog=await listed.json();
  assert.deepEqual(catalog.routes.map(route=>route.reasoning),['none','low','medium','high','xhigh','max']);
  assert.ok(catalog.routes.every(route=>route.provider==='OpenAI'&&route.disclosureVersion===2));
  assert.equal((await send(origin)).status,401);
  assert.equal((await send(origin,'fixture-old',1)).status,409);
  assert.equal((await send(origin,'fixture-unknown',2,'unknown')).status,503);
  assert.equal(calls(),0);
  assert.equal(data.reservedMicroUSD,0);
  const response=await send(origin,'fixture-one');
  assert.equal(response.status,200);
  assert.equal(response.headers.get('X-PrivateChat-Beta-Usage'),'99');
  const stream=await response.text();
  assert.match(stream,/Synthetic reply/);
  assert.match(stream,/event: done/);
  assert.equal(calls(),1);
  assert.equal(data.reservedMicroUSD,routeSpecification(route.id,route).minimumReservationMicroUSD);
  assert.equal((await send(origin,'fixture-one')).status,401);
  assert.equal(calls(),1);
  assert.equal(data.reservedMicroUSD,routeSpecification(route.id,route).minimumReservationMicroUSD);
});

test('the beta ledger rejects over-budget attempts before a provider call',async t=>{
  const {server,data,calls}=fixture({reservedMicroUSD:5_000_000});
  const origin=await start(t,server);
  const catalog=await fetch(origin+'/v1/models');
  assert.equal(catalog.headers.get('X-PrivateChat-Beta-Usage'),'0');
  const response=await send(origin,'fixture-capped');
  assert.equal(response.status,429);
  assert.deepEqual(await response.json(),{error:'beta_allowance_exhausted'});
  assert.equal(data.reservedMicroUSD,5_000_000);
  assert.equal(calls(),0);
});

test('beta routes cannot satisfy the production Zero Data Retention gate',()=>{
  const now=Date.now();
  const promoted={...route,enabled:true,retentionProfile:'zdr',verifiedUntil:now+1000};
  assert.throws(()=>activeRoute({enabled:true,fetchedAt:now,routes:[promoted]},route.id,now),{code:'route_unavailable'});
});
