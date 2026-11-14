import {createHash} from 'node:crypto';
export const OPENAI_SPEC=Object.freeze({id:'openai-terra-text',provider:'OpenAI',model:'gpt-5.6-terra',inputTokens:32768,outputTokens:1200,minimumReservationMicroUSD:80000});
export const CLAUDE_SPEC=Object.freeze({id:'claude-sonnet-4-6-text',provider:'Claude',model:'claude-sonnet-4-6',inputTokens:32768,outputTokens:1200,minimumReservationMicroUSD:120000});
// Reserve at standard non-global pricing, without relying on promotional credits.
export const GEMINI_SPEC=Object.freeze({id:'gemini-3-8-flash-low-text',provider:'Gemini',model:'gemini-3.8-flash',inputTokens:32768,outputTokens:2400,minimumReservationMicroUSD:80000});
export const ROUTE_SPECS=Object.freeze(Object.fromEntries([OPENAI_SPEC,CLAUDE_SPEC,GEMINI_SPEC].map(spec=>[spec.id,spec])));
export const OPENAI_BETA_PROFILE='text-openai-beta-v1';
export const OPENAI_STANDARD_PROFILE='text-openai-standard-v1';
export const OPENAI_BETA_MODEL='gpt-6.1-terra';
export function legacyCompatibleRoute(route) {
  return route.profile!==OPENAI_STANDARD_PROFILE || route.model===OPENAI_BETA_MODEL;
}
export const VERIFICATION_FLAGS=Object.freeze(['agreementApproved','payloadVerified','cacheDisabled','loggingDisabled','abuseMonitoringApproved','persistentUserIDNotRequired','pricingVerified']);
export function catalogRouteID(provider,model,reasoning) {return 'catalog-'+provider.toLowerCase()+'-'+createHash('sha256').update(model).digest('hex').slice(0,16)+'-'+reasoning;}
export function routeSpecification(id,route) {
  if(Object.hasOwn(ROUTE_SPECS,id))return ROUTE_SPECS[id];
  const levels={OpenAI:['none','low','medium','high','xhigh','max'],Claude:['low','medium','high','xhigh','max'],Gemini:['low','medium','high']};
  const prefixes={OpenAI:'gpt-',Claude:'claude-',Gemini:'gemini-'};
  const beta=route?.profile===OPENAI_BETA_PROFILE;
  const standard=route?.profile===OPENAI_STANDARD_PROFILE;
  if((beta || standard) && (route.provider!=='OpenAI' || (beta && route.model!==OPENAI_BETA_MODEL) || route.disclosureVersion!==(beta?2:3)))return undefined;
  if(route?.model==='gpt-6.1-sol' && route.reasoning==='none')return undefined;
  if(!route || (!beta && !standard && route.profile!=='text-zdr-v1') || !/^(?:beta-|standard-)?catalog-[a-z][a-z0-9-]{0,65}$/.test(id) || !levels[route.provider]?.includes(route.reasoning) ||
     typeof route.model!=='string' || !/^[a-z][a-z0-9.-]{0,119}$/.test(route.model) || !route.model.startsWith(prefixes[route.provider]) ||
     id!==(beta?'beta-':standard?'standard-':'')+catalogRouteID(route.provider,route.model,route.reasoning) || typeof route.label!=='string' || !route.label.length || route.label.length>60 || route.inputTokens!==32768 || !Number.isSafeInteger(route.outputTokens) || route.outputTokens<1200 || route.outputTokens>8192 ||
     ![route.inputMicroUSDPerToken,route.outputMicroUSDPerToken].every(value=>Number.isFinite(value)&&value>0&&value<=500))return undefined;
  const minimumReservationMicroUSD=Math.ceil(route.inputTokens*route.inputMicroUSDPerToken+route.outputTokens*route.outputMicroUSDPerToken);
  if(minimumReservationMicroUSD>2000000)return undefined;
  return Object.freeze({id,provider:route.provider,model:route.model,inputTokens:route.inputTokens,outputTokens:route.outputTokens,reasoning:route.reasoning,profile:route.profile,minimumReservationMicroUSD,dynamic:true});
}
export function providerTargetDigest(spec,target) {
  const canonical=Object.fromEntries(Object.keys(target).sort().map(key=>[key,target[key]]));
  return createHash('sha256').update(JSON.stringify({provider:spec.provider,model:spec.model,...(spec.dynamic?{reasoning:spec.reasoning,outputTokens:spec.outputTokens}:{}),target:canonical})).digest('hex');
}
export function verifiedRouteEvidence(route,now) {
  const flags=route.profile===OPENAI_STANDARD_PROFILE
    ? VERIFICATION_FLAGS.filter(flag=>flag!=='abuseMonitoringApproved').concat('standardRetentionDisclosed')
    : VERIFICATION_FLAGS;
  return /^[a-f0-9]{64}$/.test(route.targetDigest??'') && /^[a-f0-9]{64}$/.test(route.verification?.evidenceDigest??'') &&
    Number.isFinite(route.verification?.reviewedAt) && route.verification.reviewedAt<=now && route.verification.reviewedAt<route.verifiedUntil &&
    flags.every(flag=>route.verification[flag]===true);
}
