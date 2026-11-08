import {COMMERCIAL_POLICY,validateCommercialMargin} from './commercial-policy.js';
const OPENAI_BUDGET={inputTokens:32768,outputTokens:1200,inputMicroUSDPerToken:1,outputMicroUSDPerToken:5,reservationMicroUSD:40000};
const maximumInferenceMicroUSD=()=>32768+1200*5;
validateCommercialMargin(COMMERCIAL_POLICY);
const freeClaims=Number(process.argv[2]??1000);
if(!Number.isSafeInteger(freeClaims)||freeClaims<1||freeClaims>10000000) throw new Error('Expected 1–10000000 free claims');
const dollars=value=>Math.round(value)/1000000;
const typicalMicroUSD=4000*OPENAI_BUDGET.inputMicroUSDPerToken+1200*OPENAI_BUDGET.outputMicroUSDPerToken;
const ceiling=maximumInferenceMicroUSD(),reservation=OPENAI_BUDGET.reservationMicroUSD;
const freeBudget=COMMERCIAL_POLICY.trial.accountUnits,paidBudget=COMMERCIAL_POLICY.monthlyUnits,freeTurns=Math.floor(freeBudget/reservation),paidTurns=Math.floor(paidBudget/reservation);
const result={currency:'USD',providerPricingChecked:'2026-11-07',
  providerPricingSource:'https://developers.openai.com/api/docs/models/gpt-6.1-terra',
  productionVerified:false,assumptions:['Text only; no tools, caching writes or reasoning','Provider honors token limits and published pricing','Current model profiles use conservative byte estimates; live framing parity is not yet verified','Excludes infrastructure, tax and refunds; trial issuance is disabled pending hosted verification'],
  perTurn:{inputTokenCap:OPENAI_BUDGET.inputTokens,outputTokenCap:OPENAI_BUDGET.outputTokens,typical:dollars(typicalMicroUSD),maximumEstimate:dollars(ceiling),conservativeReservation:dollars(reservation)},
  freeTierProposal:{claims:freeClaims,budgetPerClaim:dollars(freeBudget),turnsPerClaim:freeTurns,typicalTotal:dollars(freeClaims*freeTurns*typicalMicroUSD),maximumEstimateTotal:dollars(freeClaims*freeTurns*ceiling),reservationTotal:dollars(freeClaims*freeTurns*reservation),identityPolicy:'verified signed Apple AppTransaction; one trial per App Store account for this app',campaign:{enabled:false,unitCap:200000000,claimCap:1000,maximumReservedProviderBudget:200}},
  tenTurnTrialComparison:{typicalTotal:dollars(freeClaims*10*typicalMicroUSD),maximumEstimateTotal:dollars(freeClaims*10*ceiling)},
  subscriptionProposal:{price:9.99,budgetPerAppleRenewalPeriod:dollars(paidBudget),fixedReservationAttempts:paidTurns,settlement:"Fixed reservation per attempt; shorter replies do not currently refund credits",maximumEstimatedProviderCost:dollars(paidTurns*ceiling),unusedCreditsCarryOver:false,gracePeriod:'shares the existing renewal allowance'},
  fleet:{turnsPerUTCDay:1000,typical30DayCost:dollars(1000*30*typicalMicroUSD),maximumEstimated30DayCost:dollars(1000*30*ceiling)},
  feeScenarios:[0.15,0.30].map(fee=>{
    const net=9990000*(1-fee),paidCost=paidTurns*ceiling,margin=net-paidCost,freeCost=freeClaims*freeTurns*ceiling;
    return {platformFeeFraction:fee,netRevenuePerSubscriber:dollars(net),revenueToModelCostRatio:net/paidBudget,revenueToAllVariableCostRatio:net/(paidBudget+COMMERCIAL_POLICY.additionalVariableCostBudgetMicroUSD),marginBeforeOtherCosts:dollars(margin),conversionsToCoverFreeClaimsBeforeOtherCosts:Math.ceil(freeCost/margin)};
  })};
console.log(JSON.stringify(result,null,2));
