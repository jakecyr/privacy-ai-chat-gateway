import {createHash} from 'node:crypto';
export const OPENAI_SPEC=Object.freeze({id:'openai-terra-text',provider:'OpenAI',model:'gpt-5.6-terra',inputTokens:32768,outputTokens:1200,minimumReservationMicroUSD:80000});
export const CLAUDE_SPEC=Object.freeze({id:'claude-sonnet-4-6-text',provider:'Claude',model:'claude-sonnet-4-6',inputTokens:32768,outputTokens:1200,minimumReservationMicroUSD:120000});
// Reserve at standard non-global pricing, without relying on promotional credits.
export const GEMINI_SPEC=Object.freeze({id:'gemini-3-8-flash-low-text',provider:'Gemini',model:'gemini-3.8-flash',inputTokens:32768,outputTokens:2400,minimumReservationMicroUSD:80000});
export const ROUTE_SPECS=Object.freeze(Object.fromEntries([OPENAI_SPEC,CLAUDE_SPEC,GEMINI_SPEC].map(spec=>[spec.id,spec])));
export const VERIFICATION_FLAGS=Object.freeze(['agreementApproved','payloadVerified','cacheDisabled','loggingDisabled','abuseMonitoringApproved','persistentUserIDNotRequired','pricingVerified']);
export function routeSpecification(id) {return Object.hasOwn(ROUTE_SPECS,id)?ROUTE_SPECS[id]:undefined;}
export function providerTargetDigest(spec,target) {
  const canonical=Object.fromEntries(Object.keys(target).sort().map(key=>[key,target[key]]));
  return createHash('sha256').update(JSON.stringify({provider:spec.provider,model:spec.model,target:canonical})).digest('hex');
}
export function verifiedRouteEvidence(route,now) {
  return /^[a-f0-9]{64}$/.test(route.targetDigest??'') && /^[a-f0-9]{64}$/.test(route.verification?.evidenceDigest??'') &&
    Number.isFinite(route.verification?.reviewedAt) && route.verification.reviewedAt<=now && route.verification.reviewedAt<route.verifiedUntil &&
    VERIFICATION_FLAGS.every(flag=>route.verification[flag]===true);
}
