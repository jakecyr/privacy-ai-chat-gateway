import {OPENAI_BUDGET,maximumInferenceMicroUSD} from './token-budget.js';
const freeClaims=Number(process.argv[2]??1000);
if(!Number.isSafeInteger(freeClaims)||freeClaims<1||freeClaims>10000000) throw new Error('Expected 1–10000000 free claims');
const dollars=value=>Math.round(value)/1000000;
const typicalMicroUSD=4000*OPENAI_BUDGET.inputMicroUSDPerToken+1200*OPENAI_BUDGET.outputMicroUSDPerToken;
const ceiling=maximumInferenceMicroUSD(),reservation=OPENAI_BUDGET.reservationMicroUSD;
const freeBudget=250000,paidBudget=3000000,freeTurns=Math.floor(freeBudget/reservation),paidTurns=Math.floor(paidBudget/reservation);
const result={currency:'USD',providerPricingChecked:'2026-11-07',
  providerPricingSource:'https://developers.openai.com/api/docs/models/gpt-5.6-terra',
  productionVerified:false,assumptions:['Text only; no tools, caching writes or reasoning','Provider honors token limits and published pricing','Local count includes a 512-token framing reserve; live parity is not yet verified','Excludes infrastructure, tax, refunds and repeated claims outside the configured fleet cap'],
  perTurn:{inputTokenCap:OPENAI_BUDGET.inputTokens,outputTokenCap:OPENAI_BUDGET.outputTokens,typical:dollars(typicalMicroUSD),maximumEstimate:dollars(ceiling),conservativeReservation:dollars(reservation)},
  freeTierProposal:{claims:freeClaims,budgetPerClaim:dollars(freeBudget),turnsPerClaim:freeTurns,typicalTotal:dollars(freeClaims*freeTurns*typicalMicroUSD),maximumEstimateTotal:dollars(freeClaims*freeTurns*ceiling),reservationTotal:dollars(freeClaims*freeTurns*reservation),identityPolicy:'unresolved; a global non-replenishing campaign cap is also required'},
  tenTurnTrialComparison:{typicalTotal:dollars(freeClaims*10*typicalMicroUSD),maximumEstimateTotal:dollars(freeClaims*10*ceiling)},
  subscriptionProposal:{price:9.99,budgetPerAppleRenewalPeriod:dollars(paidBudget),fixedReservationAttempts:paidTurns,settlement:"Fixed reservation per attempt; shorter replies do not currently refund credits",maximumEstimatedProviderCost:dollars(paidTurns*ceiling),unusedCreditsCarryOver:false,gracePeriod:'shares the existing renewal allowance'},
  fleet:{turnsPerUTCDay:1000,typical30DayCost:dollars(1000*30*typicalMicroUSD),maximumEstimated30DayCost:dollars(1000*30*ceiling)},
  feeScenarios:[0.15,0.30].map(fee=>{
    const net=9990000*(1-fee),paidCost=paidTurns*ceiling,margin=net-paidCost,freeCost=freeClaims*freeTurns*ceiling;
    return {platformFeeFraction:fee,netRevenuePerSubscriber:dollars(net),marginBeforeOtherCosts:dollars(margin),conversionsToCoverFreeClaimsBeforeOtherCosts:Math.ceil(freeCost/margin)};
  })};
console.log(JSON.stringify(result,null,2));
