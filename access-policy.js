import {ROUTE_SPECS,routeSpecification} from './route-specs.js';
import {validateIssuerCreditPolicy} from './token-budget.js';
import {validateTrialPolicy} from './trial-access.js';

// Public commercial metadata only; no account, campaign totals or credentials.
export function accessPolicy(config,trial,dictationUnits) {
  validateIssuerCreditPolicy(config);validateTrialPolicy(trial);
  return Object.freeze({version:1,unitScale:1000,
    trial:{enabled:trial.enabled,limitUnits:trial.accountUnits,reset:'lifetime_apple_account'},
    subscription:{limitUnits:config.monthlyUnits,productIDs:[...config.productIDs],reset:'verified_apple_renewal',rollover:false,...(config.monthlyUnitsByProduct?{planLimits:config.monthlyUnitsByProduct}:{})},
    reservation:'per_attempt_no_refund',
    ...(dictationUnits ? { dictationUnits } : {}),
    routes:Object.entries(config.routeCosts).map(([id,units])=>{const configured=config.modelRoutes?.find(route=>route.id===id);const spec=routeSpecification(id,configured);return {id,provider:spec.provider,model:spec.model,units,...(spec.dynamic?{reasoning:spec.reasoning,profile:spec.profile,label:configured.label,disclosureVersion:configured.disclosureVersion}:{})};})});
}
