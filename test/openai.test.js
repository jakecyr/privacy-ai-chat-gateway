import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openAIPayload,openAIAdapter} from '../openai-adapter.js';
const input={messages:[{role:'user',text:'synthetic'}],memory:['metric units']};
const route={provider:'OpenAI',model:'gpt-5.6-terra'};
test('golden provider payload has only approved fields and no identifiers or state',()=>{
 const payload=openAIPayload(input);
 assert.deepEqual(Object.keys(payload).sort(),['model','stream','store','reasoning','max_output_tokens','prompt_cache_options','instructions','input'].sort());
 assert.equal(payload.store,false);assert.equal(payload.max_output_tokens,1200);
 assert.deepEqual(payload.reasoning,{effort:'none'});assert.deepEqual(payload.prompt_cache_options,{mode:'explicit'});
 assert.equal(payload.input.at(-1).content,'synthetic');
});
test('provider adapter sends one request, translates deltas, and cancels reader',async()=>{
 let calls=0;
 const adapter=openAIAdapter({apiKey:'test-only',fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(options.redirect,'error');
  return new Response('data: {"type":"response.created","response":{"model":"gpt-5.6-terra"}}\n\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\ndata: {"type":"response.completed","response":{"model":"gpt-5.6-terra"}}\n\n');
 }});
 const events=[];for await(const e of adapter(route,input,new AbortController().signal)) events.push(e);
 assert.equal(calls,1);assert.deepEqual(events,[{type:'delta',text:'hello'},{type:'done',reason:'stop'}]);
});
test('provider stream handles CRLF and split UTF-8 without forwarding metadata',async()=>{
 const wire=Buffer.from(': heartbeat\r\n\r\ndata: {"type":"response.created","response":{"model":"gpt-5.6-terra","id":"PRIVATE_ID"}}\r\n\r\ndata: {"type":"response.output_text.delta","delta":"🌱"}\r\n\r\ndata: {"type":"response.completed","response":{"model":"gpt-5.6-terra"}}\r\n\r\n');
 const stream=new ReadableStream({start(controller){for(const byte of wire)controller.enqueue(Uint8Array.of(byte));controller.close();}});
 const adapter=openAIAdapter({apiKey:'test-only',fetchImpl:async()=>new Response(stream)});
 const events=[];for await(const event of adapter(route,input,new AbortController().signal))events.push(event);
 assert.deepEqual(events,[{type:'delta',text:'🌱'},{type:'done',reason:'stop'}]);
});
test('wrong or absent serving model is rejected before emitting any text',async()=>{
 for(const prefix of ['', 'data: {"type":"response.created","response":{"model":"other-model"}}\n\n']) {
  const adapter=openAIAdapter({apiKey:'test-only',fetchImpl:async()=>new Response(prefix+'data: {"type":"response.output_text.delta","delta":"PRIVATE_WRONG_ROUTE"}\n\n')});
  await assert.rejects(async()=>{for await(const _ of adapter(route,input,new AbortController().signal))assert.fail('no text may leave wrong model');},{message:'upstream_failure'});
 }
});
test('provider failures never leak upstream details or retry',async()=>{
 let calls=0;
 const adapter=openAIAdapter({apiKey:'test-only',fetchImpl:async()=>{calls++;return new Response('SECRET_PROVIDER_ERROR',{status:500});}});
 await assert.rejects(async()=>{for await(const _ of adapter(route,input,new AbortController().signal)){}},error=>error.message==='upstream_failure');
 assert.equal(calls,1);
});
