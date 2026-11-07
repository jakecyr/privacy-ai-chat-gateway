import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createProviderDispatcher} from '../provider-dispatcher.js';
import {OPENAI_SPEC,CLAUDE_SPEC,GEMINI_SPEC,VERIFICATION_FLAGS,providerTargetDigest} from '../route-specs.js';
import {activeRoute,publicModels,GatewayError} from '../admission.js';
import {claudeAdapter} from '../claude-adapter.js';
import {geminiAdapter} from '../gemini-adapter.js';
import {createProductionServer} from '../production-server.js';
import {validateIssuerCreditPolicy} from '../token-budget.js';
const evidence=()=>({evidenceDigest:'b'.repeat(64),reviewedAt:Date.now(),...Object.fromEntries(VERIFICATION_FLAGS.map(flag=>[flag,true]))});
const approved=spec=>({...spec,enabled:true,retentionProfile:'zdr',disclosureVersion:1,verifiedUntil:Date.now()+3600000,targetDigest:'a'.repeat(64),verification:evidence()});
const config=routes=>({enabled:true,version:1,fetchedAt:Date.now(),routes});
const input={messages:[{role:'user',text:'synthetic'}],memory:[]};

test('immutable route identities require dated independent evidence for every provider',async()=>{
 for(const spec of [OPENAI_SPEC,CLAUDE_SPEC,GEMINI_SPEC]) {
  const route=approved(spec);assert.ok(Object.isFrozen(spec));
  assert.equal(activeRoute(config([route]),spec.id).model,spec.model);
  for(const flag of VERIFICATION_FLAGS) {
   const changed={...route,verification:{...route.verification,[flag]:false}};
   assert.throws(()=>activeRoute(config([changed]),spec.id),error=>error.code==='route_unavailable');
  }
  for(const changed of [{...route,verification:undefined},{...route,targetDigest:''},{...route,verification:{...route.verification,reviewedAt:Date.now()+100000}},{...route,provider:'wrong'},{...route,model:'different-model'},{...route,disclosureVersion:2},{...route,verifiedUntil:Date.now()-1}]) assert.throws(()=>activeRoute(config([changed]),spec.id),error=>error.code==='route_unavailable');
 }
 const disabled=JSON.parse(await readFile(new URL('../infrastructure/route-disabled.json',import.meta.url)).catch(error=>{if(error.code!=='ENOENT')throw error;return readFile(new URL('../../infrastructure/route-disabled.json',import.meta.url))}));
 assert.deepEqual(publicModels({...disabled,enabled:true,fetchedAt:Date.now()}).routes,[]);
});
test('dispatcher hides unconfigured, quarantined or changed credential/region targets from discovery',async()=>{
 const openai=approved(OPENAI_SPEC),claude=approved(CLAUDE_SPEC),gemini=approved(GEMINI_SPEC);let healthy=true;
 const registrations=new Map([[openai.id,{targetDigest:openai.targetDigest,generate:Object.assign(async function*(){yield {type:'done',reason:'stop'}},{healthy:()=>healthy})}],
  [claude.id,{targetDigest:'c'.repeat(64),generate:async function*(){throw new Error('must not call')}}]]);
 const dispatch=createProviderDispatcher(registrations);const load=dispatch.configuration(async()=>config([openai,claude,gemini]));
 assert.deepEqual(publicModels(await load()).routes.map(route=>route.id),[openai.id]);
 healthy=false;assert.deepEqual(publicModels(await load()).routes,[]);
 assert.notEqual(providerTargetDigest(GEMINI_SPEC,{projectID:'synthetic-project',location:'us'}),providerTargetDigest(GEMINI_SPEC,{projectID:'synthetic-project',location:'eu'}));
 assert.equal(providerTargetDigest(GEMINI_SPEC,{projectID:'synthetic-project',location:'us'}),providerTargetDigest(GEMINI_SPEC,{location:'us',projectID:'synthetic-project'}));
});
test('a selected provider failure never invokes another adapter',async()=>{
 const calls={OpenAI:0,Claude:0,Gemini:0};
 const registrations=new Map([OPENAI_SPEC,CLAUDE_SPEC,GEMINI_SPEC].map(spec=>[spec.id,{targetDigest:'a'.repeat(64),generate:async function*(){calls[spec.provider]++;throw new GatewayError(503,'upstream_failure')}}]));
 const dispatch=createProviderDispatcher(registrations);
 await assert.rejects(async()=>{for await(const _ of dispatch.generate(approved(CLAUDE_SPEC),input,new AbortController().signal)){}},error=>error.code==='upstream_failure');
 assert.deepEqual(calls,{OpenAI:0,Claude:1,Gemini:0});
});
test('weighted issuer budgets cover every implemented route and reject cheap new-provider weights',()=>{
 const routeCosts={[OPENAI_SPEC.id]:80000,[CLAUDE_SPEC.id]:120000,[GEMINI_SPEC.id]:80000};
 assert.doesNotThrow(()=>validateIssuerCreditPolicy({routeCosts,monthlyUnits:3000000}));
 for(const spec of [CLAUDE_SPEC,GEMINI_SPEC]) assert.throws(()=>validateIssuerCreditPolicy({routeCosts:{[spec.id]:spec.minimumReservationMicroUSD-1},monthlyUnits:3000000}),{message:'invalid_credit_configuration'});
});
for(const spec of [CLAUDE_SPEC,GEMINI_SPEC])test(`attested HTTP dispatch reaches only the pinned ${spec.provider} adapter`,async t=>{
 let calls=0,credits=0,spent=0;const route=approved(spec);
 const fetchImpl=async()=>{
  calls++;
  const objects=spec.provider==='Claude'?[
   {type:'message_start',message:{role:'assistant',model:spec.model,usage:{input_tokens:10,output_tokens:1,cache_creation_input_tokens:0,cache_read_input_tokens:0}}},
   {type:'content_block_start',index:0,content_block:{type:'text',text:'Synthetic reply'}},{type:'content_block_stop',index:0},
   {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:4}},{type:'message_stop'}
  ]:[{modelVersion:spec.model,candidates:[{content:{role:'model',parts:[{text:'Synthetic reply'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:4,thoughtsTokenCount:1,totalTokenCount:15}}];
  return new Response(objects.map(object=>'data: '+JSON.stringify(object)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
 };
 const generate=spec.provider==='Claude'?claudeAdapter({apiKey:'synthetic',fetchImpl}):geminiAdapter({projectID:'synthetic-project',location:'us',getAccessToken:async()=> 'synthetic',fetchImpl});
 const dispatcher=createProviderDispatcher(new Map([[spec.id,{targetDigest:route.targetDigest,generate}]]));
 const server=createProductionServer({configuration:dispatcher.configuration(async()=>config([route])),generate:dispatcher.generate,
  appCheck:{verifyToken:async(_token,options)=>{assert.deepEqual(options,{consume:true});return {appId:'allowed'}}},allowedAppIDs:['allowed'],quota:{take:async()=>credits++},validateVoucher:async()=>{},spendVoucher:async()=>spent++});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close()});
 const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/stream`,{method:'POST',headers:{'Content-Type':'application/json','X-Firebase-AppCheck':'synthetic',Authorization:'Bearer synthetic'},body:JSON.stringify({...input,route:spec.id,disclosureVersion:1})});
 assert.equal(response.status,200);const wire=await response.text();assert.match(wire,/Synthetic reply/);assert.equal((wire.match(/event: done/g)||[]).length,1);assert.doesNotMatch(wire,/thoughtSignature|usageMetadata|cache_read_input_tokens/);
 assert.equal(calls,1);assert.equal(credits,1);assert.equal(spent,1);
});
