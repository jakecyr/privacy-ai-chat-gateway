import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appleNotificationHandler,firestoreNotificationRecorder} from '../apple-notifications.js';

const transaction={bundleId:'app',environment:'Sandbox',productId:'monthly',type:'Auto-Renewable Subscription',originalTransactionId:'PRIVATE_TRANSACTION'};
const event={version:'2.0',notificationUUID:'60f403d5-706e-4110-a2af-0ec531c2619a',signedDate:1000,notificationType:'REFUND',data:{bundleId:'app',environment:'Sandbox',signedTransactionInfo:'PRIVATE_JWS'}};
test('notification verifies both signatures and stores only hashed reconciliation metadata',async()=>{
  const stored=[];
  const handler=appleNotificationHandler({verifier:{verifyAndDecodeNotification:async()=>event,verifyAndDecodeTransaction:async()=>transaction},bundleID:'app',environment:'Sandbox',productIDs:['monthly'],hmacKey:Buffer.alloc(32,1),record:async value=>stored.push(value),now:()=>2000});
  await handler('SIGNED_NOTIFICATION');
  assert.equal(stored.length,1);
  assert.match(stored[0].ledgerID,/^[a-f0-9]{64}$/);
  assert.match(stored[0].digest,/^[a-f0-9]{64}$/);
  assert.equal(stored[0].type,'REFUND');
  assert.ok(!JSON.stringify(stored).includes('PRIVATE'));
});
test('foreign app, unsigned nested transaction and future notification are rejected',async()=>{
  for(const modified of [{...event,data:{...event.data,bundleId:'other'}},{...event,signedDate:999999999},{...event,notificationUUID:'invalid'}]) {
    const handler=appleNotificationHandler({verifier:{verifyAndDecodeNotification:async()=>modified},bundleID:'app',environment:'Sandbox',productIDs:['monthly'],record:()=>assert.fail('must not record'),now:()=>2000});
    await assert.rejects(handler('signed'),{message:'notification_invalid'});
  }
  const handler=appleNotificationHandler({verifier:{verifyAndDecodeNotification:async()=>event,verifyAndDecodeTransaction:async()=>{throw new Error('PRIVATE_ERROR')}},bundleID:'app',environment:'Sandbox',productIDs:['monthly'],record:()=>assert.fail('must not record'),now:()=>2000});
  await assert.rejects(handler('signed'),{message:'notification_invalid'});
});
test('duplicate notifications are idempotent and older renewal cannot overwrite refund',async()=>{
  const records=new Map();let writes=0;
  const database={collection:collection=>({doc:id=>`${collection}/${id}`}),runTransaction:async operation=>operation({get:async id=>({exists:records.has(id),data:()=>records.get(id)}),create:(id,data)=>{assert.ok(!records.has(id));records.set(id,data);writes++},set:(id,data)=>{records.set(id,data);writes++}})};
  const record=firestoreNotificationRecorder(database);
  const base={ledgerID:'ledger',expiresAt:new Date(100000)};
  await record({...base,digest:'new',signedDate:2000,type:'REFUND'});
  await record({...base,digest:'new',signedDate:2000,type:'REFUND'});
  assert.equal(writes,2);
  await record({...base,digest:'old',signedDate:1000,type:'DID_RENEW'});
  assert.equal(records.get('entitlementSignals/ledger').type,'REFUND');
  assert.equal(writes,3);
});
