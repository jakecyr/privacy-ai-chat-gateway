import {VerificationException,VerificationStatus} from '@apple/app-store-server-library';
import {GatewayError} from './admission.js';
import {billingLedgerID,issueVoucher} from './vouchers.js';

export function appleAppIdentityVerifier({verifier,bundleID,appAppleID,environment,now=()=>Date.now()}) {
  return async signedAppTransaction=>{
    let value;
    try {value=await verifier.verifyAndDecodeAppTransaction(signedAppTransaction);}
    catch(error) {
      if(error instanceof VerificationException && error.status!==VerificationStatus.RETRYABLE_VERIFICATION_FAILURE)throw new GatewayError(403,'app_transaction_invalid');
      throw new GatewayError(503,'app_verification_unavailable');
    }
    try {
      if(value.bundleId!==bundleID || value.receiptType!==environment ||
         (environment==='Production' && value.appAppleId!==appAppleID) ||
         typeof value.appTransactionId!=='string'||!value.appTransactionId.length||value.appTransactionId.length>256 ||
         !Number.isSafeInteger(value.receiptCreationDate)||value.receiptCreationDate<=0||value.receiptCreationDate>now()+300000) throw new Error();
      // Stable account/app identity only; no email, app account or device ID.
      return value.appTransactionId;
    } catch {throw new GatewayError(403,'app_transaction_invalid');}
  };
}
export function validateTrialPolicy(policy) {
  if(!policy || typeof policy.enabled!=='boolean' || typeof policy.campaignID!=='string' || !/^[a-z0-9-]{1,60}$/.test(policy.campaignID) ||
     !Number.isSafeInteger(policy.accountUnits)||policy.accountUnits<1||policy.accountUnits>10000000 ||
     !Number.isSafeInteger(policy.campaignUnits)||policy.campaignUnits<policy.accountUnits||policy.campaignUnits>1000000000000 ||
     !Number.isSafeInteger(policy.claimLimit)||policy.claimLimit<1||policy.claimLimit>10000000)throw new Error('invalid_trial_configuration');
}
const count=record=>{
  const reserved=record.exists?record.data().reserved:0;
  if(!Number.isSafeInteger(reserved)||reserved<0)throw new GatewayError(503,'allowance_unavailable');
  return reserved;
};
function snapshot(policy,account,campaign,units) {
  const used=count(account),spent=count(campaign),claims=campaign.exists?campaign.data().claims:0;
  if(!Number.isSafeInteger(claims)||claims<0)throw new GatewayError(503,'allowance_unavailable');
  const remainingUnits=Math.max(0,policy.accountUnits-used);
  let unavailableReason=null;
  if(!policy.enabled)unavailableReason='trial_unavailable';
  else if(remainingUnits<units)unavailableReason='trial_exhausted';
  else if(spent+units>policy.campaignUnits || (!account.exists && claims>=policy.claimLimit))unavailableReason='trial_campaign_exhausted';
  return {kind:'trial',limitUnits:policy.accountUnits,remainingUnits,nextAttemptUnits:units,resetAt:null,canIssue:unavailableReason===null,unavailableReason,claims,used,spent};
}
export function firestoreTrialAllowance(database,policy) {
  validateTrialPolicy(policy);
  const references=ledgerID=>{
    if(!/^[a-f0-9]{64}$/.test(ledgerID))throw new GatewayError(400,'invalid_allowance');
    return [database.collection('trialAccounts').doc(ledgerID),database.collection('trialCampaigns').doc(policy.campaignID)];
  };
  const validateUnits=units=>{if(!Number.isSafeInteger(units)||units<1||units>10000000)throw new GatewayError(400,'invalid_allowance');};
  const publicSnapshot=value=>{const {claims,used,spent,...result}=value;return result;};
  return {
    reserve:async({ledgerID,units,unitCost=units})=>{
      validateUnits(units);validateUnits(unitCost);const [accountRef,campaignRef]=references(ledgerID);
      return database.runTransaction(async tx=>{
        const account=await tx.get(accountRef),campaign=await tx.get(campaignRef);
        const value=snapshot(policy,account,campaign,units);
        if(!value.canIssue)throw new GatewayError(value.unavailableReason==='trial_exhausted'?402:429,value.unavailableReason);
        // One atomic commit covers per-account units, campaign units and claims.
        // Account records live outside campaigns: a new campaign cannot reset an account.
        tx.set(accountRef,{reserved:value.used+units});
        tx.set(campaignRef,{reserved:value.spent+units,claims:value.claims+(account.exists?0:1)});
        const remainingUnits=value.remainingUnits-units;
        const unavailableReason=remainingUnits<unitCost?'trial_exhausted':policy.campaignUnits-value.spent-units<unitCost?'trial_campaign_exhausted':null;
        return {...publicSnapshot(value),remainingUnits,nextAttemptUnits:unitCost,canIssue:unavailableReason===null,unavailableReason};
      });
    },
    read:async({ledgerID,units})=>{
      validateUnits(units);const [accountRef,campaignRef]=references(ledgerID);
      const [account,campaign]=await Promise.all([accountRef.get(),campaignRef.get()]);
      return publicSnapshot(snapshot(policy,account,campaign,units));
    }
  };
}
export function trialIssuer({verifyIdentity,allowance,privateKey,kid,issuer,audience,hmacKey,routeCosts,policy,now=()=>Math.floor(Date.now()/1000)}) {
  validateTrialPolicy(policy);
  if(!routeCosts || !Object.keys(routeCosts).length || Object.values(routeCosts).some(cost=>!Number.isSafeInteger(cost)||cost<1||cost*5>10000000))throw new Error('invalid_credit_configuration');
  const costs=Object.freeze({...routeCosts});
  const authorize=async body=>{
    if(typeof body.signedAppTransaction!=='string'||!body.signedAppTransaction.length||body.signedAppTransaction.length>32768 ||
       !Object.hasOwn(costs,body.route)||!Number.isSafeInteger(body.count)||body.count<1||body.count>5)throw new GatewayError(400,'invalid_request');
    if(!policy.enabled)throw new GatewayError(503,'trial_unavailable');
    const identity=await verifyIdentity(body.signedAppTransaction);
    if(typeof identity!=='string'||!identity.length||identity.length>256)throw new GatewayError(403,'app_transaction_invalid');
    return {ledgerID:billingLedgerID('trial:'+identity,hmacKey),units:body.count*costs[body.route],unitCost:costs[body.route]};
  };
  const issue=async body=>{
    const owner=await authorize(body);
    const remaining=await allowance.reserve(owner),timestamp=now(),expiresAt=timestamp+3600;
    const tokens=Array.from({length:body.count},()=>issueVoucher({privateKey,kid,issuer,audience,route:body.route,now:timestamp,expiresAt}));
    return {tokens,allowance:remaining};
  };
  issue.status=async body=>{
    if(body.count!==1)throw new GatewayError(400,'invalid_request');
    return allowance.read(await authorize(body));
  };
  return issue;
}
