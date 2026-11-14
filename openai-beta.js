import {createHash} from 'node:crypto';
import {GatewayError} from './admission.js';
import {createChatServer} from './production-server.js';
import {openAIAdapter} from './openai-adapter.js';
import {catalogRouteID,OPENAI_BETA_MODEL,OPENAI_BETA_PROFILE,routeSpecification} from './route-specs.js';

const lifetimeBudgetMicroUSD=5_000_000;
function betaUsageHeaders(reserved) {
  if(!Number.isSafeInteger(reserved)||reserved<0) throw new GatewayError(503,'quota_unavailable');
  const remaining=lifetimeBudgetMicroUSD-reserved;
  const percent=remaining<cheapestBetaAttempt ? 0 : Math.max(1,Math.floor(100*remaining/lifetimeBudgetMicroUSD));
  return {'X-PrivateChat-Beta-Usage':String(percent)};
}
const outputTokens={none:1200,low:2400,medium:4096,high:6144,xhigh:8192,max:8192};

export const openAIBetaRoutes=Object.freeze(Object.entries(outputTokens).map(([reasoning,limit])=>Object.freeze({
  id:'beta-'+catalogRouteID('OpenAI',OPENAI_BETA_MODEL,reasoning),
  provider:'OpenAI',model:OPENAI_BETA_MODEL,label:'GPT-6.1 Terra',reasoning,
  profile:OPENAI_BETA_PROFILE,disclosureVersion:2,inputTokens:32768,outputTokens:limit,
  inputMicroUSDPerToken:1,outputMicroUSDPerToken:5,
})));
const cheapestBetaAttempt=Math.min(...openAIBetaRoutes.map(route=>routeSpecification(route.id,route).minimumReservationMicroUSD));

export function createOpenAIBetaServer({appCheck,allowedAppIDs,database,apiKey,expiresAt,fetchImpl=fetch,now=Date.now}) {
  if(!Number.isSafeInteger(expiresAt)||expiresAt<=now()||expiresAt-now()>30*86400_000) throw new Error('invalid_beta_expiry');
  const ledger=database.collection('generationQuotas').doc('openai-testflight-v1');
  const disable=()=>ledger.set({disabled:true},{merge:true});
  const generate=openAIAdapter({apiKey,fetchImpl,onUsageViolation:disable});
  const resolveRoute=(configuration,id)=>{
    const route=configuration.routes.find(candidate=>candidate.id===id);
    if(now()>=expiresAt||!route) throw new GatewayError(503,'route_unavailable');
    return route;
  };
  const configuration=async()=>{
    const data=(await ledger.get()).data()??{};
    return {version:1,fetchedAt:Date.now(),reservedMicroUSD:data.reservedMicroUSD??0,
      routes:now()<expiresAt&&data.disabled!==true?openAIBetaRoutes:[]};
  };
  const admit=(request,route,signal)=>database.runTransaction(async tx=>{
    // Some attestation token types do not report prior consumption. Bind admission
    // and its usage charge to one verified token without keeping the token itself.
    const digest=createHash('sha256').update(request.headers['x-firebase-appcheck']).digest('hex');
    const spent=database.collection('betaAppCheckTokens').doc(digest);
    const consumed=await tx.get(spent);
    const snapshot=await tx.get(ledger);
    if(consumed.exists) throw new GatewayError(401,'attestation_invalid');
    if(signal.aborted) throw new GatewayError(503,'upstream_timeout');
    const data=snapshot.data()??{};
    if(data.disabled===true||now()>=expiresAt) throw new GatewayError(503,'route_unavailable');
    const reserved=data.reservedMicroUSD??0;
    if(!Number.isSafeInteger(reserved)||reserved<0) throw new GatewayError(503,'quota_unavailable');
    const cost=routeSpecification(route.id,route).minimumReservationMicroUSD;
    if(reserved+cost>lifetimeBudgetMicroUSD) throw new GatewayError(429,'beta_allowance_exhausted');
    tx.set(ledger,{reservedMicroUSD:reserved+cost},{merge:true});
    tx.set(spent,{expiresAt:new Date(now()+8*86400_000)});
    return betaUsageHeaders(reserved+cost);
  });
  return createChatServer({appCheck,allowedAppIDs,configuration,resolveRoute,generate,admit,
    catalogHeaders:config=>betaUsageHeaders(config.reservedMicroUSD)});
}
