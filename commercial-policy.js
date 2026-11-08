// Draft launch terms. RevenueCat/App Store metadata and measured costs must be
// reconciled at activation; these values never grant an entitlement.
export const COMMERCIAL_POLICY=Object.freeze({priceMicroUSD:9990000,monthlyUnits:1000000,additionalVariableCostBudgetMicroUSD:250000,minimumNetRevenueToCostRatio:5,
 trial:Object.freeze({enabled:false,campaignID:'launch-v1',accountUnits:200000,campaignUnits:200000000,claimLimit:1000})});
export function validateCommercialMargin({monthlyUnits,commercialPolicy=COMMERCIAL_POLICY}) {
 const {priceMicroUSD,additionalVariableCostBudgetMicroUSD,minimumNetRevenueToCostRatio}=commercialPolicy;
 if(![priceMicroUSD,monthlyUnits,additionalVariableCostBudgetMicroUSD].every(Number.isSafeInteger)||priceMicroUSD<1||monthlyUnits<1||additionalVariableCostBudgetMicroUSD<0||!Number.isFinite(minimumNetRevenueToCostRatio)||minimumNetRevenueToCostRatio<5 || priceMicroUSD*0.7/(monthlyUnits+additionalVariableCostBudgetMicroUSD)<minimumNetRevenueToCostRatio)throw new Error('commercial_margin_below_target');
}
