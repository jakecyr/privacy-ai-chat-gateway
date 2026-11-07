import {ROUTE_SPECS} from './route-specs.js';
import {validateIssuerCreditPolicy} from './token-budget.js';
import {validateTrialPolicy} from './trial-access.js';

// Public commercial metadata only; no account, campaign totals or credentials.
export function accessPolicy(config,trial) {
  validateIssuerCreditPolicy(config);validateTrialPolicy(trial);
  return Object.freeze({version:1,unitScale:1000,
    trial:{enabled:trial.enabled,limitUnits:trial.accountUnits,reset:'lifetime_apple_account'},
    subscription:{limitUnits:config.monthlyUnits,productIDs:[...config.productIDs],reset:'verified_apple_renewal',rollover:false},
    reservation:'per_attempt_no_refund',
    routes:Object.entries(config.routeCosts).map(([id,units])=>({id,provider:ROUTE_SPECS[id].provider,model:ROUTE_SPECS[id].model,units}))});
}
