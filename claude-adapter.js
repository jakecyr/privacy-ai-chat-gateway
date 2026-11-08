import {GatewayError} from './admission.js';
import {providerJSONEvents,conversationMessages,CONTEXT_INSTRUCTIONS} from './provider-stream.js';

import {CLAUDE_SPEC,routeSpecification} from './route-specs.js';
export {CLAUDE_SPEC} from './route-specs.js';
export function claudePayload(input,spec=CLAUDE_SPEC) {
  return {model:spec.model,stream:true,max_tokens:spec.outputTokens,...(spec.dynamic?{thinking:{type:'adaptive'},output_config:{effort:spec.reasoning}}:{thinking:{type:'disabled'}}),system:CONTEXT_INSTRUCTIONS,
    messages:conversationMessages(input).map(message=>({role:message.role,content:message.texts.map(text=>({type:'text',text}))}))};
}
export function validateClaudeInput(route,input) {
  const spec=routeSpecification(route.id??CLAUDE_SPEC.id,route);
  if(!spec || route.provider!==CLAUDE_SPEC.provider || route.model!==spec.model)throw new GatewayError(503,'route_unavailable');
  const payload=claudePayload(input,spec);
  // No provider token-counting call and no second transmission of the prompt.
  // Conservative byte budget until live tokenizer/framing parity is verified.
  const estimate=1024+Buffer.byteLength(payload.system)+payload.messages.reduce((sum,message)=>sum+message.content.reduce((n,part)=>n+Buffer.byteLength(part.text),0),0);
  if(estimate>spec.inputTokens)throw new GatewayError(413,'input_limit');
  return estimate;
}
export function claudeAdapter({apiKey,fetchImpl=fetch,onContractViolation=async()=>{}}) {
  if(!apiKey)throw new Error('provider_credential_missing');
  let quarantined=false;
  const violation=async()=>{quarantined=true;await Promise.resolve().then(onContractViolation).catch(()=>{});throw new GatewayError(503,'upstream_failure');};
  const generate=async function* generate(route,input,signal) {
    if(quarantined)throw new GatewayError(503,'route_unavailable');
    validateClaudeInput(route,input);
    const spec=routeSpecification(route.id??CLAUDE_SPEC.id,route);
    let response;
    try {response=await fetchImpl('https://api.anthropic.com/v1/messages',{method:'POST',redirect:'error',signal,
      headers:{'x-api-key':apiKey,'anthropic-version':'2023-06-01','Content-Type':'application/json'},body:JSON.stringify(claudePayload(input,spec))});}
    catch{throw new GatewayError(503,signal.aborted?'upstream_timeout':'upstream_failure');}
    let started=false,index=-1,open=false,reason,outputBytes=0,outputTokens=0,terminalUsage=false,blockType,thoughtBytes=0;
    const textEvent=text=>{
      if(typeof text!=='string')throw new GatewayError(503,'upstream_failure');
      outputBytes+=Buffer.byteLength(text);if(outputBytes>65536)throw new GatewayError(503,'output_limit');
      return {type:'delta',text};
    };
    for await(const {event,object:value} of providerJSONEvents(response,signal)) {
      if(event && event!==value.type)throw new GatewayError(503,'upstream_failure');
      if(value.type==='ping')continue;
      if(value.type==='error')throw new GatewayError(503,'upstream_failure');
      if(value.type==='message_start') {
        if(started || value.message?.model!==spec.model || value.message?.role!=='assistant')await violation();
        const usage=value.message.usage;
        if(!Number.isSafeInteger(usage?.input_tokens)||usage.input_tokens<0||usage.input_tokens>spec.inputTokens ||
           !Number.isSafeInteger(usage.output_tokens)||usage.output_tokens<0||usage.output_tokens>spec.outputTokens ||
           usage.cache_creation_input_tokens!==0 || usage.cache_read_input_tokens!==0)await violation();
        started=true;outputTokens=usage.output_tokens;continue;
      }
      if(!started)await violation();
      if(value.type==='content_block_start') {
        if(open || reason || value.index!==index+1)await violation();
        blockType=value.content_block?.type;
        if(blockType!=='text' && !(spec.dynamic && ['thinking','redacted_thinking'].includes(blockType)))await violation();
        index=value.index;open=true;
        if(blockType==='text'){const delta=textEvent(value.content_block.text);if(delta.text)yield delta;}
        else {thoughtBytes+=Buffer.byteLength(value.content_block.thinking??value.content_block.data??'');if(thoughtBytes>131072)await violation();}
      } else if(value.type==='content_block_delta') {
        if(!open || value.index!==index)await violation();
        if(blockType==='text'){if(value.delta?.type!=='text_delta')await violation();const delta=textEvent(value.delta.text);if(delta.text)yield delta;}
        else {if(blockType!=='thinking'||!['thinking_delta','signature_delta'].includes(value.delta?.type))await violation();const hidden=value.delta.thinking??value.delta.signature;if(typeof hidden!=='string')await violation();thoughtBytes+=Buffer.byteLength(hidden);if(thoughtBytes>131072)await violation();}
      } else if(value.type==='content_block_stop') {
        if(!open || value.index!==index)await violation();open=false;
      } else if(value.type==='message_delta') {
        const usage=value.usage;
        if(!Number.isSafeInteger(usage?.output_tokens)||usage.output_tokens<outputTokens||usage.output_tokens>spec.outputTokens ||
           (usage.input_tokens!==undefined && (!Number.isSafeInteger(usage.input_tokens)||usage.input_tokens<0||usage.input_tokens>spec.inputTokens)) ||
           (usage.cache_creation_input_tokens!==undefined && usage.cache_creation_input_tokens!==0) ||
           (usage.cache_read_input_tokens!==undefined && usage.cache_read_input_tokens!==0))await violation();
        outputTokens=usage.output_tokens;terminalUsage=true;
        if(value.delta?.stop_reason) {
          if(open || reason)await violation();
          if(value.delta.stop_reason==='refusal')throw new GatewayError(503,'content_blocked');
          if(!['end_turn','max_tokens'].includes(value.delta.stop_reason))await violation();
          reason=value.delta.stop_reason==='max_tokens'?'length':'stop';
        }
      } else if(value.type==='message_stop') {
        if(open || !reason || !terminalUsage)await violation();
        yield {type:'done',reason};return;
      } else await violation();
    }
    throw new GatewayError(503,'upstream_failure');
  };
  return Object.assign(generate,{healthy:()=>!quarantined});
}
