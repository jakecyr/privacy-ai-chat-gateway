import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {routeSpecification,providerTargetDigest,VERIFICATION_FLAGS} from '../route-specs.js';
import {activeRoute} from '../admission.js';
import {openAIAdapter} from '../openai-adapter.js';
import {claudeAdapter} from '../claude-adapter.js';
import {geminiAdapter} from '../gemini-adapter.js';
import {accessPolicy} from '../access-policy.js';
import {validateIssuerCreditPolicy} from '../token-budget.js';
const config=JSON.parse(await readFile(new URL('./model-routes-fixture.json',import.meta.url)));
const input={messages:[{role:'user',text:'Synthetic question'}],memory:[]};
const stream=events=>new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
const routeFor=(provider,reasoning)=>config.routes.find(route=>route.provider===provider && route.reasoning===reasoning);
test('operator model updates bind a new route ID, evidence and adequate weighted cost',()=>{
 validateIssuerCreditPolicy(config.issuerPolicy);
 assert.equal(config.issuerPolicy.monthlyUnits/config.issuerPolicy.trial.accountUnits,5);
 const policy=accessPolicy({...config.issuerPolicy,productIDs:['monthly']},config.issuerPolicy.trial);
 assert.equal(policy.routes.length,config.routes.length);
 for(const route of config.routes) {
  const spec=routeSpecification(route.id,route);assert.ok(spec);
  assert.ok(config.issuerPolicy.routeCosts[route.id]>=spec.minimumReservationMicroUSD);
  assert.equal(routeSpecification(route.id,{...route,model:route.model+'-unreviewed'}),undefined);
  assert.equal(routeSpecification(route.id,{...route,reasoning:'arbitrary'}),undefined);
  assert.equal(routeSpecification(route.id,{...route,inputMicroUSDPerToken:0}),undefined);
  assert.throws(()=>activeRoute({version:1,enabled:true,fetchedAt:Date.now(),routes:[route]},route.id));
  const enabled={...route,enabled:true,verifiedUntil:Date.now()+60000,targetDigest:providerTargetDigest(spec,{credentialSHA256:'synthetic'}),verification:{...Object.fromEntries(VERIFICATION_FLAGS.map(key=>[key,true])),evidenceDigest:'a'.repeat(64),reviewedAt:Date.now()-1000}};
  assert.equal(activeRoute({version:1,enabled:true,fetchedAt:Date.now(),routes:[enabled]},route.id).model,route.model);
 }
 assert.notEqual(routeFor('OpenAI','none').id,routeFor('OpenAI','high').id);
});
test('OpenAI uses configured current model and reasoning while filtering internal reasoning',async()=>{
 const route=routeFor('OpenAI','high');let calls=0;
 const adapter=openAIAdapter({apiKey:'synthetic',fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(options.body);
  assert.equal(body.model,route.model);assert.equal(body.reasoning.effort,'high');assert.equal(body.store,false);assert.equal(body.max_output_tokens,route.outputTokens);
  return stream([{type:'response.created',response:{model:route.model}},{type:'response.output_text.delta',delta:'Visible only'},{type:'response.completed',response:{model:route.model,usage:{input_tokens:20,output_tokens:100,total_tokens:120,input_tokens_details:{cached_tokens:0,cache_write_tokens:0},output_tokens_details:{reasoning_tokens:80}}}}]);
 }});
 const events=await Array.fromAsync(adapter(route,input,new AbortController().signal));assert.deepEqual(events,[{type:'delta',text:'Visible only'},{type:'done',reason:'stop'}]);assert.equal(calls,1);
});
test('Anthropic adaptive reasoning never forwards thinking or signatures',async()=>{
 const route=routeFor('Claude','medium');let calls=0;
 const adapter=claudeAdapter({apiKey:'synthetic',fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,'https://api.anthropic.com/v1/messages');const body=JSON.parse(options.body);
  assert.equal(body.model,route.model);assert.deepEqual(body.thinking,{type:'adaptive'});assert.deepEqual(body.output_config,{effort:'medium'});
  return stream([{type:'message_start',message:{model:route.model,role:'assistant',usage:{input_tokens:20,output_tokens:0,cache_creation_input_tokens:0,cache_read_input_tokens:0}}},
   {type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}},
   {type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'PRIVATE_THOUGHT'}},
   {type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'PRIVATE_SIGNATURE'}},
   {type:'content_block_stop',index:0},{type:'content_block_start',index:1,content_block:{type:'text',text:'Visible only'}},{type:'content_block_stop',index:1},
   {type:'message_delta',usage:{output_tokens:100},delta:{stop_reason:'end_turn'}},{type:'message_stop'}]);
 }});
 const events=await Array.fromAsync(adapter(route,input,new AbortController().signal));assert.equal(JSON.stringify(events).includes('PRIVATE_'),false);assert.deepEqual(events,[{type:'delta',text:'Visible only'},{type:'done',reason:'stop'}]);assert.equal(calls,1);
});
test('Gemini uses configured current model and level without returning thought signatures',async()=>{
 const route=routeFor('Gemini','high');let calls=0;
 const adapter=geminiAdapter({projectID:'synthetic-project',location:'global',getAccessToken:async()=>'synthetic',fetchImpl:async(url,options)=>{
  calls++;assert.ok(url.endsWith('/models/gemini-4-argon:streamGenerateContent?alt=sse'));const body=JSON.parse(options.body);
  assert.deepEqual(body.generationConfig.thinkingConfig,{thinkingLevel:'HIGH',includeThoughts:false});assert.equal(body.generationConfig.maxOutputTokens,route.outputTokens);
  return stream([{modelVersion:route.model,candidates:[{index:0,content:{parts:[{text:'Visible only',thoughtSignature:'PRIVATE_SIGNATURE'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:20,candidatesTokenCount:3,thoughtsTokenCount:7,totalTokenCount:30}}]);
 }});
 const events=await Array.fromAsync(adapter(route,input,new AbortController().signal));assert.equal(JSON.stringify(events).includes('PRIVATE_'),false);assert.deepEqual(events,[{type:'delta',text:'Visible only'},{type:'done',reason:'stop'}]);assert.equal(calls,1);
});

test('launch commercial policy refuses a provider allowance below the requested margin',async()=>{
 const {COMMERCIAL_POLICY,validateCommercialMargin}=await import('../commercial-policy.js');
 assert.doesNotThrow(()=>validateCommercialMargin(COMMERCIAL_POLICY));
 assert.throws(()=>validateCommercialMargin({...COMMERCIAL_POLICY,monthlyUnits:3000000}),/commercial_margin_below_target/);
 assert.throws(()=>validateCommercialMargin({...COMMERCIAL_POLICY,commercialPolicy:{...COMMERCIAL_POLICY,priceMicroUSD:1000000}}),/commercial_margin_below_target/);
});
