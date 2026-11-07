import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {initializeApp,deleteApp} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
import {firestoreTrialAllowance} from '../trial-access.js';
import {firestoreAllowance,firestoreAllowanceReader,billingLedgerID} from '../vouchers.js';
// Refuse any path that could contact a real project or a non-local database.
assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:18590');
assert.equal(process.env.GCLOUD_PROJECT,'demo-private-ai-allowance');
const app=initializeApp({projectId:'demo-private-ai-allowance'});
const db=getFirestore(app),key=Buffer.alloc(32,7);
after(async()=>{await db.terminate();await deleteApp(app)});
test('real Firestore transactions bound concurrent campaign claims and units',async()=>{
 const bank=firestoreTrialAllowance(db,{enabled:true,campaignID:'integration-v1',accountUnits:250000,campaignUnits:250000,claimLimit:1000});
 const results=await Promise.allSettled(Array.from({length:50},(_,i)=>bank.reserve({ledgerID:billingLedgerID('synthetic-'+i,key),units:80000})));
 assert.equal(results.filter(x=>x.status==='fulfilled').length,3);
 assert.ok(results.filter(x=>x.status==='rejected').every(x=>x.reason.code==='trial_campaign_exhausted'));
 assert.deepEqual((await db.doc('trialCampaigns/integration-v1').get()).data(),{reserved:240000,claims:3});
 assert.equal((await db.collection('trialAccounts').get()).size,3);
});
test('paid limits freeze for a renewal and status remains read-only',async()=>{
 const ledgerID=billingLedgerID('paid',key),window=billingLedgerID('renewal',key),reserve=firestoreAllowance(db),read=firestoreAllowanceReader(db);
 assert.equal((await read({ledgerID,window,limit:3000000})).remainingUnits,3000000);
 assert.equal((await db.collection('allowances').get()).size,0);
 await reserve({ledgerID,window,limit:3000000,units:80000});
 assert.deepEqual(await reserve({ledgerID,window,limit:10000,units:80000}),{limitUnits:3000000,remainingUnits:2840000});
 assert.equal((await read({ledgerID,window,limit:9000000})).limitUnits,3000000);
});
test('mobile clients cannot read or write billing ledger documents',async()=>{
 const origin='http://127.0.0.1:18590/v1/projects/demo-private-ai-allowance/databases/(default)/documents';
 const read=await fetch(origin+'/trialCampaigns/integration-v1');assert.equal(read.status,403);
 const write=await fetch(origin+'/trialAccounts/unauthorized',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({fields:{reserved:{integerValue:'0'}}})});assert.equal(write.status,403);
});
