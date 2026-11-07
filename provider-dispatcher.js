import {GatewayError} from './admission.js';
import {routeSpecification} from './route-specs.js';
import {validateInputBudget} from './token-budget.js';
import {validateClaudeInput} from './claude-adapter.js';
import {validateGeminiInput} from './gemini-adapter.js';

export function validateProviderInputBudget(route,input) {
  const spec=routeSpecification(route.id);
  if(!spec || route.model!==spec.model || route.provider!==spec.provider)throw new GatewayError(503,'route_unavailable');
  if(spec.provider==='OpenAI')return validateInputBudget(route,input);
  if(spec.provider==='Claude')return validateClaudeInput(route,input);
  return validateGeminiInput(route,input);
}
export function createProviderDispatcher(registrations) {
  const available=route=>{
    const registration=registrations.get(route.id);
    return !!registration && registration.targetDigest===route.targetDigest && (registration.generate.healthy?.()??true);
  };
  const configuration=load=>async()=>{
    const current=await load();
    return {...current,routes:(current.routes??[]).map(route=>({...route,enabled:route.enabled===true && available(route)}))};
  };
  const generate=async function*(route,input,signal) {
    validateProviderInputBudget(route,input);
    if(!available(route))throw new GatewayError(503,'route_unavailable');
    // Exactly one chosen adapter. Never retry, fan out, or move an existing chat.
    yield* registrations.get(route.id).generate(route,input,signal);
  };
  return {generate,configuration};
}
