import {test} from 'node:test';
import assert from 'node:assert/strict';
import {geminiAdapter,geminiPayload,validateGeminiInput,GEMINI_SPEC} from '../gemini-adapter.js';
const input={messages:[{role:'user',text:'first'},{role:'assistant',text:'answer'},{role:'user',text:'latest'}],memory:['metric units']};
const route={...GEMINI_SPEC};
const first={modelVersion:GEMINI_SPEC.model,candidates:[{index:0,content:{role:'model',parts:[{text:'🌱 reply',thoughtSignature:'PRIVATE_SIGNATURE'}]}}]};
const last={modelVersion:GEMINI_SPEC.model,candidates:[{index:0,finishReason:'STOP'}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:5,thoughtsTokenCount:10,totalTokenCount:115,cachedContentTokenCount:0}};
const response=objects=>new Response(objects.map(object=>'data: '+JSON.stringify(object)+'\r\n\r\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
const options={projectID:'synthetic-project',location:'us',getAccessToken:async()=> 'SYNTHETIC_OAUTH_TOKEN'};
async function collect(generate,value=input) {const output=[];for await(const event of generate(route,value,new AbortController().signal))output.push(event);return output;}

test('Gemini payload fixes low thinking/output, omits unsupported candidateCount and sends no state or tools',()=>{
 const body=geminiPayload(input);
 assert.deepEqual(Object.keys(body).sort(),['systemInstruction','contents','generationConfig'].sort());
 assert.deepEqual(body.generationConfig,{maxOutputTokens:2400,thinkingConfig:{thinkingLevel:'LOW',includeThoughts:false}});
 assert.equal(body.contents[0].parts.length,2);assert.equal(body.contents[1].role,'model');assert.equal(body.contents.at(-1).parts[0].text,'latest');
 assert.throws(()=>validateGeminiInput({...route,model:'gemini-2.5-flash'},input),error=>error.code==='route_unavailable');
});
test('Gemini performs one fixed workload-authenticated request and strips signatures/metadata',async()=>{
 let calls=0,credentials=0;
 const generate=geminiAdapter({...options,getAccessToken:async()=>{credentials++;return 'SYNTHETIC_OAUTH_TOKEN'},fetchImpl:async(url,request)=>{
  calls++;assert.equal(url,'https://us-aiplatform.googleapis.com/v1/projects/synthetic-project/locations/us/publishers/google/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
  assert.equal(request.redirect,'error');assert.equal(request.headers['x-goog-user-project'],'synthetic-project');assert.equal(request.headers.Authorization,'Bearer SYNTHETIC_OAUTH_TOKEN');assert.deepEqual(JSON.parse(request.body),geminiPayload(input));
  return response([first,last]);
 }});
 assert.deepEqual(await collect(generate),[{type:'delta',text:'🌱 reply'},{type:'done',reason:'stop'}]);assert.equal(calls,1);assert.equal(credentials,1);
});
test('Gemini refuses arbitrary hosts, regions and malformed project names',()=>{
 for(const config of [{location:'https://evil.invalid'},{projectID:'../../other'},{projectID:'invalid/id'},{getAccessToken:'not-a-function'}]) assert.throws(()=>geminiAdapter({...options,...config}),{message:'provider_configuration_missing'});
});
test('Gemini supports terminal usage-only chunks and preserves token-limit stop reason',async()=>{
 const terminal=structuredClone(last);terminal.candidates[0].finishReason='MAX_TOKENS';delete terminal.usageMetadata;
 const generate=geminiAdapter({...options,fetchImpl:async()=>response([first,terminal,{usageMetadata:last.usageMetadata}])});
 assert.equal((await collect(generate)).at(-1).reason,'length');
 const missing=geminiAdapter({...options,fetchImpl:async()=>response([{...first,usageMetadata:last.usageMetadata},terminal])});
 await assert.rejects(collect(missing),error=>error.code==='upstream_failure');
});
test('Gemini wrong model, multiple candidates and cache usage quarantine without fallback',async()=>{
 const variants=[{...first,modelVersion:'different-model'},{...first,candidates:[first.candidates[0],first.candidates[0]]},{...last,usageMetadata:{...last.usageMetadata,cachedContentTokenCount:1}}];
 for(const value of variants) {
  let calls=0,disabled=0;
  const generate=geminiAdapter({...options,onContractViolation:async()=>{disabled++;throw new Error('PRIVATE_ERROR');},fetchImpl:async()=>{calls++;return response([value]);}});
  await assert.rejects(collect(generate),error=>error.code==='upstream_failure');assert.equal(disabled,1);
  await assert.rejects(collect(generate),error=>error.code==='route_unavailable');assert.equal(calls,1);
 }
});
test('Gemini safety blocks, unexpected tools/thoughts and out-of-budget reasoning never succeed',async()=>{
 const variants=[{promptFeedback:{blockReason:'SAFETY'}},{...last,candidates:[{finishReason:'SAFETY'}]},
  {...first,candidates:[{content:{parts:[{functionCall:{name:'SECRET_TOOL'}}]}}]},
  {...first,candidates:[{content:{parts:[{text:'PRIVATE_THOUGHT',thought:true}]}}]},
  {...last,usageMetadata:{...last.usageMetadata,thoughtsTokenCount:2400,totalTokenCount:2505}},
  {...last,usageMetadata:{...last.usageMetadata,totalTokenCount:999}}];
 for(const value of variants) {
  const generate=geminiAdapter({...options,fetchImpl:async()=>response([value])});
  await assert.rejects(collect(generate),error=>['upstream_failure','content_blocked'].includes(error.code));
 }
});
test('Gemini oversize and aborted credentials prevent dispatch; provider HTTP failures do not retry',async()=>{
 let calls=0,credentials=0;
 const generate=geminiAdapter({...options,getAccessToken:async()=>{credentials++;return 'synthetic'},fetchImpl:async()=>{calls++;return new Response('PRIVATE_PROVIDER_ERROR',{status:503});}});
 await assert.rejects(collect(generate,{messages:[{role:'user',text:'x'.repeat(32768)}],memory:[]}),error=>error.code==='input_limit');assert.equal(credentials,0);assert.equal(calls,0);
 await assert.rejects(collect(generate),error=>error.code==='upstream_failure');assert.equal(calls,1);
 const abort=new AbortController();const cancelled=geminiAdapter({...options,getAccessToken:async()=>{abort.abort();return 'synthetic'},fetchImpl:async()=>{calls++;throw new Error('must not dispatch')}});
 await assert.rejects(async()=>{for await(const _ of cancelled(route,input,abort.signal)){}},error=>error.code==='upstream_timeout');assert.equal(calls,1);
});

test('known safety or invalid usage in a frame blocks its text before forwarding',async()=>{
 for(const mutation of [value=>value.candidates[0].finishReason='SAFETY',value=>value.usageMetadata={...last.usageMetadata,cachedContentTokenCount:1}]) {
  const value=structuredClone(first);mutation(value);const emitted=[];
  const generate=geminiAdapter({...options,fetchImpl:async()=>response([value])});
  await assert.rejects(async()=>{for await(const event of generate(route,input,new AbortController().signal))emitted.push(event)},error=>['content_blocked','upstream_failure'].includes(error.code));
  assert.deepEqual(emitted,[]);
 }
});
