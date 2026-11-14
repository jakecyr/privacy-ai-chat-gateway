// Draft launch terms. RevenueCat/App Store metadata and measured costs must be
// reconciled at activation; these values never grant an entitlement.
export const COMMERCIAL_POLICY=Object.freeze({priceMicroUSD:9990000,monthlyUnits:1000000,additionalVariableCostBudgetMicroUSD:250000,minimumNetRevenueToCostRatio:5,
 trial:Object.freeze({enabled:false,campaignID:'launch-v1',accountUnits:200000,campaignUnits:200000000,claimLimit:1000})});
export function validateCommercialMargin({monthlyUnits,commercialPolicy=COMMERCIAL_POLICY}) {
 const {priceMicroUSD,additionalVariableCostBudgetMicroUSD,minimumNetRevenueToCostRatio}=commercialPolicy;
 if(![priceMicroUSD,monthlyUnits,additionalVariableCostBudgetMicroUSD].every(Number.isSafeInteger)||priceMicroUSD<1||monthlyUnits<1||additionalVariableCostBudgetMicroUSD<0||!Number.isFinite(minimumNetRevenueToCostRatio)||minimumNetRevenueToCostRatio<5 || priceMicroUSD*0.7/(monthlyUnits+additionalVariableCostBudgetMicroUSD)<minimumNetRevenueToCostRatio)throw new Error('commercial_margin_below_target');
}


// U.S. launch proposals. Store and issuer configuration must agree before checkout.
export const LAUNCH_PLANS=Object.freeze({
 'org.livingwire.privateaichat.cloud.monthly':Object.freeze({priceMicroUSD:9990000,monthlyUnits:1000000,additionalVariableCostBudgetMicroUSD:250000}),
 'org.livingwire.privateaichat.cloud.pro.monthly':Object.freeze({priceMicroUSD:19990000,monthlyUnits:2000000,additionalVariableCostBudgetMicroUSD:500000}),
 'org.livingwire.privateaichat.cloud.proplus.monthly':Object.freeze({priceMicroUSD:39990000,monthlyUnits:4000000,additionalVariableCostBudgetMicroUSD:1000000}),
});

export function validateSubscriptionTerms(config) {
 const limits=config.monthlyUnitsByProduct;
 if(limits===undefined) { validateCommercialMargin(config); return; }
 if(!limits||typeof limits!=='object'||Array.isArray(limits)||!Array.isArray(config.productIDs)||
    !config.productIDs.length||Object.keys(limits).length!==config.productIDs.length||
    new Set(config.productIDs).size!==config.productIDs.length||
    config.productIDs.some(id=>!Object.hasOwn(LAUNCH_PLANS,id)||!Object.hasOwn(limits,id)||!Number.isSafeInteger(limits[id])||limits[id]<1)||
    Math.max(...Object.values(limits))!==config.monthlyUnits) throw new Error('invalid_subscription_terms');
 for(const id of config.productIDs) {
  validateCommercialMargin({monthlyUnits:limits[id],
   commercialPolicy:{...LAUNCH_PLANS[id],minimumNetRevenueToCostRatio:COMMERCIAL_POLICY.minimumNetRevenueToCostRatio}});
 }
}
