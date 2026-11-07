import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appleEntitlementVerifier} from '../apple-entitlement.js';
const current={bundleId:'app',environment:'Sandbox',productId:'monthly',type:'Auto-Renewable Subscription',originalTransactionId:'original',transactionId:'paid-period-1',purchaseDate:500000,expiresDate:2000000};
function verifierFor({transaction=current,status=1,grace,apiError=false}={}) {
 return appleEntitlementVerifier({bundleID:'app',productIDs:['monthly'],environment:'Sandbox',now:()=>1000000,
 verifier:{verifyAndDecodeTransaction:async jws=>jws==='presented'?current:transaction,verifyAndDecodeRenewalInfo:async()=>grace},
 api:{getAllSubscriptionStatuses:async()=>{if(apiError)throw new Error('PRIVATE_ERROR');return {bundleId:'app',environment:'Sandbox',data:[{lastTransactions:[{status,signedTransactionInfo:'current',signedRenewalInfo:grace?'renewal':undefined}]}]};}}});
}
test('issuance reconciles signed transaction with current Apple state',async()=>{
 assert.deepEqual(await verifierFor()('presented'),{active:true,originalTransactionID:'original',periodTransactionID:'paid-period-1',periodEndsAt:2000,inGracePeriod:false,expiresAt:2000});
 for(const options of [{status:5},{status:2},{transaction:{...current,revocationDate:900000}},{transaction:{...current,productId:'other'}},{transaction:{...current,environment:'Production'}},{transaction:{...current,expiresDate:500000}},{transaction:{...current,originalTransactionId:'another'}},{transaction:{...current,transactionId:undefined}},{transaction:{...current,purchaseDate:undefined}},{transaction:{...current,purchaseDate:1000001}},{transaction:{...current,purchaseDate:2100000}}]) await assert.rejects(verifierFor(options)('presented'));
});
test('grace period requires verified matching renewal and expires at grace end',async()=>{
 const grace={originalTransactionId:'original',environment:'Sandbox',gracePeriodExpiresDate:3000000};
 const verified=await verifierFor({status:4,grace})('presented');
 assert.equal(verified.expiresAt,3000);assert.equal(verified.periodTransactionID,'paid-period-1');
 await assert.rejects(verifierFor({status:4})('presented'));
 await assert.rejects(verifierFor({status:4,grace:{...grace,originalTransactionId:'another'}})('presented'));
});
test('Apple dependency error fails closed with safe error',async()=>{
 await assert.rejects(verifierFor({apiError:true})('presented'),error=>error.message==='subscription_verification_unavailable');
});

test('presenting an old signed transaction cannot choose the allowance renewal period',async()=>{
 const verified=await verifierFor({transaction:{...current,transactionId:'paid-period-2',purchaseDate:900000}})('presented');
 assert.equal(verified.periodTransactionID,'paid-period-2');
});
