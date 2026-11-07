import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {VerificationException,VerificationStatus} from '@apple/app-store-server-library';
import {appleAppIdentityVerifier,firestoreTrialAllowance,trialIssuer} from '../trial-access.js';
import {verifyVoucher,issueVoucher,billingLedgerID,firestoreAllowance,firestoreAllowanceReader,voucherIssuer} from '../vouchers.js';
import {createBillingServer} from '../billing-server.js';
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const policy={enabled:true,campaignID:'launch-v1',accountUnits:250000,campaignUnits:250000000,claimLimit:1000};
const credentials={privateKey,kid:'v1',issuer:'billing',audience:'chat',hmacKey:Buffer.alloc(32,7),routeCosts:{terra:80000,claude:120000},now:()=>1000};
function database() {
 const records=new Map();let queue=Promise.resolve();
 const snapshot=key=>({exists:records.has(key),data:()=>records.get(key)});
 const db={records,collection:name=>({doc:id=>({key:name+'/'+id,get:async()=>snapshot(name+'/'+id)})}),runTransaction:operation=>{
  const result=queue.then(async()=>{
   const writes=new Map();
   const value=await operation({get:async ref=>snapshot(ref.key),set:(ref,data)=>writes.set(ref.key,data)});
   for(const [key,data] of writes)records.set(key,data);
   return value;
  });queue=result.catch(()=>{});return result;
 }};return db;
}
const issuer=(db,identity='PRIVATE_APP_ACCOUNT',config=policy)=>trialIssuer({...credentials,policy:config,allowance:firestoreTrialAllowance(db,config),verifyIdentity:async()=>identity});
const body={signedAppTransaction:'synthetic-signed-app-transaction',route:'terra',count:1};

test('app receipt verification checks signed app, environment, identifier and creation date',async()=>{
 const valid={bundleId:'app',appAppleId:123,receiptType:'Production',appTransactionId:'PRIVATE_APP_ACCOUNT',receiptCreationDate:500000};
 const options={bundleID:'app',appAppleID:123,environment:'Production',now:()=>1000000};
 assert.equal(await appleAppIdentityVerifier({...options,verifier:{verifyAndDecodeAppTransaction:async()=>valid}})('signed'),'PRIVATE_APP_ACCOUNT');
 for(const invalid of [{...valid,bundleId:'other'},{...valid,appAppleId:999},{...valid,receiptType:'Sandbox'},{...valid,appTransactionId:''},{...valid,receiptCreationDate:1300001}]) await assert.rejects(appleAppIdentityVerifier({...options,verifier:{verifyAndDecodeAppTransaction:async()=>invalid}})('signed'),error=>error.code==='app_transaction_invalid');
 await assert.rejects(appleAppIdentityVerifier({...options,verifier:{verifyAndDecodeAppTransaction:async()=>{throw new VerificationException(VerificationStatus.INVALID_CERTIFICATE)}}})('signed'),error=>error.code==='app_transaction_invalid');
 await assert.rejects(appleAppIdentityVerifier({...options,verifier:{verifyAndDecodeAppTransaction:async()=>{throw new Error('PRIVATE_OCSP_ERROR')}}})('signed'),error=>error.code==='app_verification_unavailable');
});
test('reinstall and concurrent devices share one lifetime allowance, and vouchers reveal no account or plan',async()=>{
 const db=database(),deviceA=issuer(db),deviceB=issuer(db);
 const results=await Promise.allSettled(Array.from({length:30},(_,index)=>(index%2?deviceA:deviceB)(body)));
 const successes=results.filter(value=>value.status==='fulfilled');assert.equal(successes.length,3);
 assert.ok(results.filter(value=>value.status==='rejected').every(value=>value.reason.code==='trial_exhausted'));
 assert.equal(db.records.size,2);assert.equal([...db.records].find(([key])=>key.startsWith('trialCampaigns/'))[1].claims,1);
 for(const result of successes) {
  const token=result.value.tokens[0],claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url'));
  assert.deepEqual(Object.keys(claims).sort(),['iss','aud','iat','exp','nonce','route'].sort());
  assert.equal(verifyVoucher(token,{publicKeys:{v1:publicKey},issuer:'billing',audience:'chat',route:'terra',now:1001}).expiresAt,4600);
 }
 assert.equal(JSON.stringify([...db.records]).includes('PRIVATE_APP_ACCOUNT'),false);
 const reinstalled=issuer(db);await assert.rejects(reinstalled(body),error=>error.code==='trial_exhausted');
});
test('campaign claim and unit limits are atomic and account allowance does not reset with a new campaign',async()=>{
 const db=database(),limited={...policy,claimLimit:2,campaignUnits:250000};
 const a=issuer(db,'PRIVATE_ACCOUNT_A',limited),b=issuer(db,'PRIVATE_ACCOUNT_B',limited),c=issuer(db,'PRIVATE_ACCOUNT_C',limited);
 await a(body);await b(body);
 await assert.rejects(c(body),error=>error.code==='trial_campaign_exhausted');
 assert.equal(db.records.size,3);
 const last=await a(body);assert.equal(last.allowance.canIssue,false);assert.equal(last.allowance.unavailableReason,'trial_campaign_exhausted');
 await assert.rejects(b(body),error=>error.code==='trial_campaign_exhausted');
 assert.equal(db.records.get('trialCampaigns/launch-v1').reserved,240000);
 const newCampaign=issuer(db,'PRIVATE_ACCOUNT_A',{...limited,campaignID:'launch-v2'});
 await assert.rejects(newCampaign({...body,route:'claude'}),error=>error.code==='trial_exhausted');
 assert.equal(db.records.has('trialCampaigns/launch-v2'),false);
});
test('route weights share a trial pool and read-only status never creates a claim',async()=>{
 const db=database(),trial=issuer(db);
 const initial=await trial.status(body);assert.equal(initial.remainingUnits,250000);assert.equal(initial.nextAttemptUnits,80000);assert.equal(db.records.size,0);
 await trial({...body,route:'claude'});const result=await trial(body);
 assert.equal(result.allowance.remainingUnits,50000);assert.equal(result.allowance.canIssue,false);
 const status=await trial.status(body);assert.equal(status.remainingUnits,50000);assert.equal(status.unavailableReason,'trial_exhausted');
 const before=JSON.stringify([...db.records]);await assert.rejects(trial({...body,count:5}),error=>error.code==='trial_exhausted');assert.equal(JSON.stringify([...db.records]),before);
 let verified=0;const disabled={...policy,enabled:false};const off=trialIssuer({...credentials,policy:disabled,allowance:firestoreTrialAllowance(db,disabled),verifyIdentity:async()=>{verified++;return 'private'}});
 await assert.rejects(off(body),error=>error.code==='trial_unavailable');assert.equal(verified,0);
});
test('paid balance uses verified renewal period and reading status cannot reserve credit',async()=>{
 const db=database(),paid=voucherIssuer({...credentials,monthlyUnits:3000000,includeAllowance:true,reserve:firestoreAllowance(db),readAllowance:firestoreAllowanceReader(db),verifyTransaction:async()=>({active:true,expiresAt:3000,periodEndsAt:3000,inGracePeriod:false,originalTransactionID:'PRIVATE_PAID',periodTransactionID:'PRIVATE_RENEWAL'})});
 const request={signedTransaction:'signed',route:'terra',count:1};
 const before=await paid.status(request);assert.equal(before.remainingUnits,3000000);assert.equal(before.resetAt,3000);assert.equal(db.records.size,0);
 const result=await paid(request);assert.equal(result.allowance.remainingUnits,2920000);assert.equal(result.allowance.kind,'subscription');assert.equal(result.tokens.length,1);
 assert.equal((await paid.status(request)).remainingUnits,2920000);assert.equal(db.records.size,1);assert.equal(JSON.stringify([...db.records]).includes('PRIVATE_'),false);
});
test('billing trial/status endpoints consume attestation and reject unsigned identity or mixed credentials',async t=>{
 const db=database(),trial=issuer(db);let consumed=0;
 const server=createBillingServer({appCheck:{verifyToken:async(_token,options)=>{assert.deepEqual(options,{consume:true});consumed++;return {appId:'app'}}},allowedAppIDs:['app'],issue:trial,inspect:trial.status});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close()});
 const origin=`http://127.0.0.1:${server.address().port}`;
 const post=(path,value)=>fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json','X-Firebase-AppCheck':'synthetic'},body:JSON.stringify(value)});
 for(const invalid of [{appTransactionId:'UNSIGNED',route:'terra',count:1},{...body,signedTransaction:'another'},{...body,accountUnits:99999999},{...body,messages:['PRIVATE_CHAT']},{...body,count:0}]) assert.equal((await post('/v1/access/issue',invalid)).status,400);
 const state=await post('/v1/access/status',body);assert.equal(state.status,200);assert.equal((await state.json()).allowance.kind,'trial');assert.equal(db.records.size,0);
 const issued=await post('/v1/access/issue',body);assert.equal(issued.status,200);const result=await issued.json();assert.equal(result.vouchers.length,1);assert.equal(result.allowance.remainingUnits,170000);
 assert.equal(consumed,7);assert.equal(issued.headers.get('cache-control'),'no-store');
});

test('concurrent distinct accounts cannot exceed the shared campaign bank',async()=>{
 const db=database(),limited={...policy,campaignUnits:250000};
 const results=await Promise.allSettled(Array.from({length:50},(_,index)=>issuer(db,'PRIVATE_ACCOUNT_'+index,limited)(body)));
 assert.equal(results.filter(value=>value.status==='fulfilled').length,3);
 assert.equal(db.records.get('trialCampaigns/launch-v1').reserved,240000);assert.equal(db.records.get('trialCampaigns/launch-v1').claims,3);assert.equal(db.records.size,4);
});
test('published policy is identifier-free and a stale policy cannot reserve credits',async t=>{
 const {accessPolicy}=await import('../access-policy.js');
 const metadata=accessPolicy({monthlyUnits:3000000,productIDs:['monthly'],routeCosts:{'openai-terra-text':80000}},policy);
 assert.equal(metadata.subscription.limitUnits,3000000);assert.equal(metadata.trial.limitUnits,250000);
 assert.equal(JSON.stringify(metadata).includes('launch-v1'),false);assert.equal(JSON.stringify(metadata).includes('campaignUnits'),false);
 let reservations=0;
 const server=createBillingServer({appCheck:{verifyToken:async()=>({appId:'app'})},allowedAppIDs:['app'],policy:metadata,issue:async request=>{reservations++;return [issueVoucher({...credentials,route:request.route,expiresAt:2000,now:1000})]}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close()});
 const origin=`http://127.0.0.1:${server.address().port}`;
 const response=await fetch(origin+'/v1/access/policy');assert.equal(response.status,200);assert.deepEqual(await response.json(),metadata);assert.match(response.headers.get('etag'),/^"[a-f0-9]{64}"$/);
 for(const tag of [undefined,'"stale"']) {
  const rejected=await fetch(origin+'/v1/access/issue',{method:'POST',headers:{'Content-Type':'application/json','X-Firebase-AppCheck':'synthetic',...(tag?{'If-Match':tag}:{})},body:JSON.stringify(body)});
  assert.equal(rejected.status,412);assert.deepEqual(await rejected.json(),{error:'access_policy_changed'});
 }
 assert.equal(reservations,0);
 const accepted=await fetch(origin+'/v1/access/issue',{method:'POST',headers:{'Content-Type':'application/json','X-Firebase-AppCheck':'synthetic','If-Match':response.headers.get('etag')},body:JSON.stringify({...body,route:'openai-terra-text'})});
 assert.equal(accepted.status,200);assert.equal((await accepted.json()).vouchers.length,1);assert.equal(reservations,1);
});

test('an issued paid pool keeps its promised limit until a new verified renewal',async()=>{
 const db=database();let period='PAID_PERIOD_ONE';
 const make=monthlyUnits=>voucherIssuer({...credentials,monthlyUnits,includeAllowance:true,reserve:firestoreAllowance(db),readAllowance:firestoreAllowanceReader(db),verifyTransaction:async()=>({active:true,expiresAt:3000,periodEndsAt:3000,originalTransactionID:'PRIVATE_PAID',periodTransactionID:period})});
 const request={signedTransaction:'signed',route:'terra',count:1};
 await make(3000000)(request);
 const updated=make(2000000);
 assert.equal((await updated.status(request)).limitUnits,3000000);
 assert.equal((await updated(request)).allowance.remainingUnits,2840000);
 period='PAID_PERIOD_TWO';
 assert.equal((await updated.status(request)).limitUnits,2000000);
 assert.equal((await updated(request)).allowance.remainingUnits,1920000);
});
