import {GatewayError} from './admission.js';
import {providerJSONEvents,conversationMessages,CONTEXT_INSTRUCTIONS} from './provider-stream.js';

import {GEMINI_SPEC} from './route-specs.js';
export {GEMINI_SPEC} from './route-specs.js';
export function geminiPayload(input) {
  return {systemInstruction:{parts:[{text:CONTEXT_INSTRUCTIONS}]},
    contents:conversationMessages(input,'model').map(message=>({role:message.role,parts:message.texts.map(text=>({text}))})),
    // Gemini 3.8 rejects candidateCount. It produces one candidate; the receiver
    // also rejects multiple candidates. No cache, grounding, tools or continuation.
    generationConfig:{maxOutputTokens:GEMINI_SPEC.outputTokens,thinkingConfig:{thinkingLevel:'LOW',includeThoughts:false}}};
}
export function validateGeminiInput(route,input) {
  if(route.provider!==GEMINI_SPEC.provider || route.model!==GEMINI_SPEC.model)throw new GatewayError(503,'route_unavailable');
  const payload=geminiPayload(input);
  const estimate=1024+Buffer.byteLength(CONTEXT_INSTRUCTIONS)+payload.contents.reduce((sum,message)=>sum+message.parts.reduce((n,part)=>n+Buffer.byteLength(part.text),0),0);
  if(estimate>GEMINI_SPEC.inputTokens)throw new GatewayError(413,'input_limit');
  return estimate;
}
function validUsage(usage) {
  const integer=value=>Number.isSafeInteger(value)&&value>=0;
  if(!usage || !integer(usage.promptTokenCount)||usage.promptTokenCount>GEMINI_SPEC.inputTokens ||
     !integer(usage.candidatesTokenCount)||!integer(usage.totalTokenCount) ||
     !integer(usage.thoughtsTokenCount??0) || usage.candidatesTokenCount+(usage.thoughtsTokenCount??0)>GEMINI_SPEC.outputTokens ||
     usage.totalTokenCount!==usage.promptTokenCount+usage.candidatesTokenCount+(usage.thoughtsTokenCount??0) ||
     (usage.cachedContentTokenCount??0)!==0 || (usage.toolUsePromptTokenCount??0)!==0) return false;
  return true;
}
export function geminiAdapter({projectID,location,getAccessToken,fetchImpl=fetch,onContractViolation=async()=>{}}) {
  if(typeof projectID!=='string'||!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectID) ||
     !['global','us','eu'].includes(location) || typeof getAccessToken!=='function')throw new Error('provider_configuration_missing');
  const host=location==='global'?'aiplatform.googleapis.com':`${location}-aiplatform.googleapis.com`;
  const endpoint=`https://${host}/v1/projects/${projectID}/locations/${location}/publishers/google/models/${GEMINI_SPEC.model}:streamGenerateContent?alt=sse`;
  let quarantined=false;
  const violation=async()=>{quarantined=true;await Promise.resolve().then(onContractViolation).catch(()=>{});throw new GatewayError(503,'upstream_failure');};
  const generate=async function* generate(route,input,signal) {
    if(quarantined)throw new GatewayError(503,'route_unavailable');
    validateGeminiInput(route,input);
    let response;
    try {
      const token=await getAccessToken(signal);
      if(signal.aborted)throw new Error();
      if(typeof token!=='string'||!token.length)throw new Error();
      response=await fetchImpl(endpoint,{method:'POST',redirect:'error',signal,headers:{Authorization:`Bearer ${token}`,'x-goog-user-project':projectID,'Content-Type':'application/json'},body:JSON.stringify(geminiPayload(input))});
    } catch {throw new GatewayError(503,signal.aborted?'upstream_timeout':'upstream_failure');}
    let modelVerified=false,reason,outputBytes=0;
    for await(const {object:value} of providerJSONEvents(response,signal)) {
      if(value.error)throw new GatewayError(503,'upstream_failure');
      if(value.modelVersion!==undefined) {
        if(value.modelVersion!==GEMINI_SPEC.model)await violation();
        modelVerified=true;
      }
      if(value.usageMetadata!==undefined && !validUsage(value.usageMetadata))await violation();
      if(value.promptFeedback?.blockReason)throw new GatewayError(503,'content_blocked');
      if(value.candidates!==undefined) {
        if(!Array.isArray(value.candidates)||value.candidates.length>1)await violation();
        const candidate=value.candidates[0];
        if(candidate) {
          if(!modelVerified || (candidate.index!==undefined && candidate.index!==0))await violation();
          if(candidate.safetyRatings!==undefined && !Array.isArray(candidate.safetyRatings))await violation();
          if(candidate.safetyRatings?.some(rating=>rating?.blocked===true))throw new GatewayError(503,'content_blocked');
          if(candidate.finishReason!==undefined) {
            if(reason)await violation();
            if(['SAFETY','RECITATION','BLOCKLIST','PROHIBITED_CONTENT','SPII'].includes(candidate.finishReason))throw new GatewayError(503,'content_blocked');
            if(!['STOP','MAX_TOKENS'].includes(candidate.finishReason))await violation();
          }
          if(candidate.content!==undefined) {
            if(candidate.content.role!==undefined && candidate.content.role!=='model')await violation();
            if(!Array.isArray(candidate.content.parts))await violation();
            for(const part of candidate.content.parts) {
              if(!part || typeof part!=='object' || Array.isArray(part))await violation();
              if(reason || part.thought===true || typeof part.text!=='string' || part.functionCall || part.executableCode || part.inlineData || part.fileData)await violation();
              outputBytes+=Buffer.byteLength(part.text);if(outputBytes>65536)throw new GatewayError(503,'output_limit');
              // Discard thought signatures and all other provider-only metadata.
              if(part.text)yield {type:'delta',text:part.text};
            }
          }
          if(candidate.finishReason!==undefined)reason=candidate.finishReason==='MAX_TOKENS'?'length':'stop';
        }
      }
      // Require usage from the terminal chunk (or a later usage-only chunk), not
      // a potentially provisional counter from an earlier partial response.
      if(reason && value.usageMetadata!==undefined) {yield {type:'done',reason};return;}
    }
    throw new GatewayError(503,'upstream_failure');
  };
  return Object.assign(generate,{healthy:()=>!quarantined});
}
