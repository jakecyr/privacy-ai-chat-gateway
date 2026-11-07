import {test} from 'node:test';
import assert from 'node:assert/strict';
import {claudeAdapter,claudePayload,CLAUDE_SPEC,validateClaudeInput} from '../claude-adapter.js';
import {providerJSONEvents} from '../provider-stream.js';
const input={messages:[{role:'user',text:'first'},{role:'assistant',text:'answer'},{role:'user',text:'latest'}],memory:['metric units']};
const route={...CLAUDE_SPEC};
const frame=object=>`event: ${object.type}\ndata: ${JSON.stringify(object)}\n\n`;
const start={type:'message_start',message:{role:'assistant',model:CLAUDE_SPEC.model,usage:{input_tokens:100,output_tokens:1,cache_creation_input_tokens:0,cache_read_input_tokens:0}}};
const events=[start,{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'🌱 reply'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:5}},{type:'message_stop'}];
const response=wire=>new Response(wire,{headers:{'Content-Type':'text/event-stream'}});
async function collect(generate,body=input) {const result=[];for await(const event of generate(route,body,new AbortController().signal))result.push(event);return result;}

test('Claude payload fixes model/thinking/output and omits identifiers, caching, tools and fallback',()=>{
 const payload=claudePayload(input);
 assert.deepEqual(Object.keys(payload).sort(),['model','stream','max_tokens','thinking','system','messages'].sort());
 assert.equal(payload.model,'claude-sonnet-4-6');assert.equal(payload.max_tokens,1200);assert.equal(payload.stream,true);
 assert.deepEqual(payload.thinking,{type:'disabled'});
 assert.equal(payload.messages[0].content.length,2);assert.equal(payload.messages.at(-1).content[0].text,'latest');
 assert.equal(payload.messages.length,3);assert.match(payload.messages[0].content[0].text,/Quoted user memory/);
 assert.throws(()=>validateClaudeInput({...route,model:'claude-sonnet-5-5'},input),error=>error.code==='route_unavailable');
});
test('Claude uses exactly one fixed HTTPS request and normalizes text and terminal events',async()=>{
 let calls=0;
 const generate=claudeAdapter({apiKey:'SYNTHETIC_KEY',fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,'https://api.anthropic.com/v1/messages');assert.equal(options.redirect,'error');
  assert.equal(options.headers['x-api-key'],'SYNTHETIC_KEY');assert.equal(options.headers['anthropic-version'],'2023-06-01');
  assert.deepEqual(JSON.parse(options.body),claudePayload(input));return response(events.map(frame).join(''));
 }});
 assert.deepEqual(await collect(generate),[{type:'delta',text:'🌱 reply'},{type:'done',reason:'stop'}]);assert.equal(calls,1);
});
test('provider byte parser supports CRLF, split UTF-8 and initial text without forwarding metadata',async()=>{
 const streamEvents=structuredClone(events);streamEvents[1].content_block.text='Initial ';
 const wire=Buffer.from(': heartbeat\r\n\r\n'+streamEvents.map(frame).join('').replaceAll('\n','\r\n'));
 const stream=new ReadableStream({start(controller){for(const byte of wire)controller.enqueue(Uint8Array.of(byte));controller.close();}});
 const generate=claudeAdapter({apiKey:'synthetic',fetchImpl:async()=>response(stream)});
 assert.deepEqual(await collect(generate),[{type:'delta',text:'Initial '},{type:'delta',text:'🌱 reply'},{type:'done',reason:'stop'}]);
});
test('Claude max-token stop stays a labeled length terminal and refusals never succeed',async()=>{
 for(const [stop,expected] of [['max_tokens','length'],['refusal','content_blocked']]) {
  const copy=structuredClone(events);copy[4].delta.stop_reason=stop;
  const generate=claudeAdapter({apiKey:'synthetic',fetchImpl:async()=>response(copy.map(frame).join(''))});
  if(expected==='length')assert.equal((await collect(generate)).at(-1).reason,'length');
  else await assert.rejects(collect(generate),error=>error.code===expected);
 }
});
test('Claude serving-model or cache contract violations emit no text and quarantine even when persistence fails',async()=>{
 for(const mutation of [value=>value.message.model='wrong-model',value=>value.message.usage.cache_read_input_tokens=100,value=>value.message.usage.cache_creation_input_tokens=1]) {
  let calls=0,disabled=0;const copy=structuredClone(events);mutation(copy[0]);
  const generate=claudeAdapter({apiKey:'synthetic',onContractViolation:async()=>{disabled++;throw new Error('PRIVATE_DATABASE_ERROR');},fetchImpl:async()=>{calls++;return response(copy.map(frame).join(''));}});
  const emitted=[];await assert.rejects(async()=>{for await(const event of generate(route,input,new AbortController().signal))emitted.push(event)},error=>error.code==='upstream_failure');
  assert.deepEqual(emitted,[]);assert.equal(disabled,1);
  await assert.rejects(collect(generate),error=>error.code==='route_unavailable');assert.equal(calls,1);
 }
});
test('unexpected thinking/tools, invalid block order, bad usage and missing terminal are rejected',async()=>{
 const variants=[];
 let copy=structuredClone(events);copy[1].content_block.type='thinking';variants.push(copy);
 copy=structuredClone(events);copy[1].content_block.type='tool_use';variants.push(copy);
 copy=structuredClone(events);copy[2].index=1;variants.push(copy);
 copy=structuredClone(events);copy[4].usage.output_tokens=1201;variants.push(copy);
 copy=structuredClone(events);delete copy[4].usage;variants.push(copy);
 variants.push(events.slice(0,-1));variants.push(events.slice(1));
 for(const variant of variants) {
  const generate=claudeAdapter({apiKey:'synthetic',fetchImpl:async()=>response(variant.map(frame).join(''))});
  await assert.rejects(collect(generate),error=>error.code==='upstream_failure');
 }
});
test('Claude oversize and HTTP failure do not retry or expose provider bodies',async()=>{
 let calls=0;
 const generate=claudeAdapter({apiKey:'synthetic',fetchImpl:async()=>{calls++;return new Response('PRIVATE_PROVIDER_ERROR',{status:500});}});
 await assert.rejects(collect(generate,{messages:[{role:'user',text:'x'.repeat(32768)}],memory:[]}),error=>error.code==='input_limit');assert.equal(calls,0);
 await assert.rejects(collect(generate),error=>error.code==='upstream_failure');assert.equal(calls,1);
});
test('provider parser rejects invalid UTF-8, oversized frames, malformed JSON and wrong media',async()=>{
 for(const value of [response(Uint8Array.from([100,97,116,97,58,32,255,10,10])),response('data: '+ 'x'.repeat(262145)),response('data: {\n\n'),new Response('{}',{headers:{'Content-Type':'application/json'}})]) {
  await assert.rejects(async()=>{for await(const _ of providerJSONEvents(value,new AbortController().signal)){}},error=>error.code==='upstream_failure');
 }
});
