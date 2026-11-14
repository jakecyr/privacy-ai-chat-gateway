import {openAIPayload} from '../openai-payload.js';
import {openAIBetaRoutes} from '../openai-beta.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {estimatedOpenAIInputTokens,validateInputBudget,validateOpenAIUsage,maximumInferenceMicroUSD,validateIssuerCreditPolicy,OPENAI_BUDGET} from '../token-budget.js';
import {openAIAdapter} from '../openai-adapter.js';
const route={id:'openai-terra-text',provider:'OpenAI',model:'gpt-5.6-terra'};
const input={messages:[{role:'user',text:'Hello world'}],memory:[]};

test('token budget counts quoted memories and treats special-token spellings as literal text',()=>{
  const base=estimatedOpenAIInputTokens(input);
  assert.ok(base>OPENAI_BUDGET.framingReserve);
  assert.ok(estimatedOpenAIInputTokens({...input,memory:['metric units']})>base);
  assert.doesNotThrow(()=>validateInputBudget(route,{...input,messages:[{role:'user',text:'<|endoftext|> 🌱 中文'}]}));
  assert.throws(()=>validateInputBudget({...route,model:'unapproved'},input),error=>error.code==='route_unavailable');
  assert.equal(maximumInferenceMicroUSD(),79936);
  assert.ok(OPENAI_BUDGET.reservationMicroUSD>=maximumInferenceMicroUSD());
});
test('the dynamic OpenAI input ceiling includes system instructions and framing',()=>{
 const route=openAIBetaRoutes[0];
 const input={memory:[],messages:[{role:'user',text:''}]};
 const instructions=openAIPayload(input,route).instructions;
 const maximumUserBytes=route.inputTokens-1024-Buffer.byteLength(instructions);
 input.messages[0].text='a'.repeat(maximumUserBytes);
 assert.equal(validateInputBudget(route,input),route.inputTokens);
 input.messages[0].text+='a';
 assert.throws(()=>validateInputBudget(route,input),{code:'input_limit'});
});

test('pathological text exceeding token budget is rejected without any provider dispatch',async()=>{
  let calls=0;
  const large={messages:[{role:'user',text:'\x7f'.repeat(32500)}],memory:[]};
  assert.ok(estimatedOpenAIInputTokens(large)>OPENAI_BUDGET.inputTokens);
  assert.ok(Buffer.byteLength(JSON.stringify({...large,route:route.id,disclosureVersion:1}))<32768,'wire bound alone must not cover this case');
  const generate=openAIAdapter({apiKey:'synthetic',fetchImpl:async()=>{calls++;throw new Error('must not call');}});
  await assert.rejects(async()=>{for await(const _ of generate(route,large,new AbortController().signal)){}},error=>error.code==='input_limit');
  assert.equal(calls,0);
});
test('malformed, out-of-budget, cached or reasoning usage is not accepted as terminal success',()=>{
  const good={input_tokens:100,output_tokens:5,total_tokens:105,input_tokens_details:{cached_tokens:0,cache_write_tokens:0},output_tokens_details:{reasoning_tokens:0}};
  assert.deepEqual(validateOpenAIUsage(good),{inputTokens:100,outputTokens:5});
  for(const bad of [undefined,{},{...good,input_tokens_details:undefined},{...good,output_tokens_details:undefined}, {...good,input_tokens:-1},{...good,input_tokens:1.5},{...good,input_tokens:32769,total_tokens:32774},{...good,output_tokens:1201,total_tokens:1301},{...good,total_tokens:104},{...good,input_tokens_details:{cached_tokens:1}},{...good,output_tokens_details:{reasoning_tokens:1}},{...good,input_tokens_details:{cache_write_tokens:100}},{...good,input_tokens_details:{cache_write_tokens:0,cache_write_tokens_details:{ttl_12h_tokens:1}}}]) assert.throws(()=>validateOpenAIUsage(bad),error=>error.code==='upstream_failure');
});
test('usage violation quarantines the adapter even if persistent circuit breaker fails',async()=>{
  let calls=0,disabled=0;
  const generate=openAIAdapter({apiKey:'synthetic',onUsageViolation:async()=>{disabled++;throw new Error('PRIVATE_DATABASE_ERROR');},fetchImpl:async()=>{
    calls++;
    return new Response('data: {"type":"response.created","response":{"model":"gpt-5.6-terra"}}\n\ndata: {"type":"response.completed","response":{"model":"gpt-5.6-terra","usage":{"input_tokens":100,"output_tokens":1201,"total_tokens":1301}}}\n\n');
  }});
  const events=[];
  await assert.rejects(async()=>{for await(const event of generate(route,input,new AbortController().signal))events.push(event)},error=>error.code==='upstream_failure');
  assert.deepEqual(events,[]);assert.equal(disabled,1);
  await assert.rejects(async()=>{for await(const _ of generate(route,input,new AbortController().signal)){}},error=>error.code==='route_unavailable');
  assert.equal(calls,1);
});

test('pinned JavaScript tokenizer matches official OpenAI tokenizer fixtures',async()=>{
  const {readFile}=await import('node:fs/promises');
  const {get_encoding}=await import('tiktoken');
  const reference=JSON.parse(await readFile(new URL('./tokenizer-fixtures.json',import.meta.url)));
  const encoding=get_encoding('o200k_base');
  for(const fixture of reference.fixtures) {
    const text=fixture.text??fixture.repeat.repeat(fixture.count);
    const actual=Array.from(encoding.encode_ordinary(text));
    if(fixture.tokens) assert.deepEqual(actual,fixture.tokens);
    else assert.equal(actual.length,fixture.tokenCount);
  }
  encoding.free();
});

test('production issuer refuses under-reserved or unimplemented model credit policies',()=>{
 assert.doesNotThrow(()=>validateIssuerCreditPolicy({routeCosts:{'openai-terra-text':80000},monthlyUnits:3000000}));
 for(const config of [
   {routeCosts:{'openai-terra-text':79999},monthlyUnits:3000000},
   {routeCosts:{'openai-terra-text':80000,unverified:80000},monthlyUnits:3000000},
   {routeCosts:{unverified:80000},monthlyUnits:3000000},
   {routeCosts:{'openai-terra-text':80000},monthlyUnits:79999}
 ]) assert.throws(()=>validateIssuerCreditPolicy(config),{message:'invalid_credit_configuration'});
});
