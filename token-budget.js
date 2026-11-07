import {get_encoding} from 'tiktoken';
import {GatewayError} from './admission.js';
import {openAIPayload} from './openai-payload.js';

// Compiled limits cannot be increased by request fields or remote configuration.
// OpenAI's official tiktoken model registry maps GPT-5 prefixes to o200k_base.
export const OPENAI_BUDGET=Object.freeze({inputTokens:32768,outputTokens:1200,framingReserve:512,
  inputMicroUSDPerToken:2,outputMicroUSDPerToken:12,reservationMicroUSD:80000});
let encoding;
export function estimatedOpenAIInputTokens(input) {
  encoding??=get_encoding('o200k_base');
  const payload=openAIPayload(input);
  // Count literal special-token spellings as ordinary user text, not control tokens.
  const count=text=>encoding.encode_ordinary(text).length;
  return count(payload.instructions)+payload.input.reduce((sum,message)=>sum+count(message.content),0)+OPENAI_BUDGET.framingReserve;
}
export function validateInputBudget(route,input) {
  if(route.provider!=='OpenAI'||route.model!=='gpt-5.6-terra') throw new GatewayError(503,'route_unavailable');
  const tokens=estimatedOpenAIInputTokens(input);
  if(tokens>OPENAI_BUDGET.inputTokens) throw new GatewayError(413,'input_limit');
  return tokens;
}
export function validateOpenAIUsage(usage) {
  const integer=value=>Number.isSafeInteger(value)&&value>=0;
  if(!usage || !integer(usage.input_tokens) || !integer(usage.output_tokens) || !integer(usage.total_tokens) ||
     usage.input_tokens>OPENAI_BUDGET.inputTokens || usage.output_tokens>OPENAI_BUDGET.outputTokens ||
     usage.total_tokens!==usage.input_tokens+usage.output_tokens ||
     usage.input_tokens_details?.cached_tokens!==0 ||
     usage.input_tokens_details?.cache_write_tokens!==0 ||
     (usage.input_tokens_details?.cache_write_tokens_details?.ttl_30m_tokens!==undefined && usage.input_tokens_details.cache_write_tokens_details.ttl_30m_tokens!==0) ||
     (usage.input_tokens_details?.cache_write_tokens_details?.ttl_12h_tokens!==undefined && usage.input_tokens_details.cache_write_tokens_details.ttl_12h_tokens!==0) ||
     usage.output_tokens_details?.reasoning_tokens!==0) {
    throw new GatewayError(503,'upstream_failure');
  }
  return Object.freeze({inputTokens:usage.input_tokens,outputTokens:usage.output_tokens});
}
// This is a conservative reservation estimate, pending live framing/pricing verification.
export function maximumInferenceMicroUSD() {
  return OPENAI_BUDGET.inputTokens*OPENAI_BUDGET.inputMicroUSDPerToken + OPENAI_BUDGET.outputTokens*OPENAI_BUDGET.outputMicroUSDPerToken;
}

export function validateIssuerCreditPolicy({routeCosts,monthlyUnits}) {
  if(!Number.isSafeInteger(monthlyUnits)||monthlyUnits<1||monthlyUnits>1000000000 ||
     !routeCosts || Object.keys(routeCosts).length!==1 ||
     !Number.isSafeInteger(routeCosts['openai-terra-text']) ||
     routeCosts['openai-terra-text']<OPENAI_BUDGET.reservationMicroUSD ||
     routeCosts['openai-terra-text']>monthlyUnits) throw new Error('invalid_credit_configuration');
}
