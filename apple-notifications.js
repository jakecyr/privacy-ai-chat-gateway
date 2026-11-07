import {createHash} from 'node:crypto';
import {GatewayError} from './admission.js';
import {billingLedgerID} from './vouchers.js';

// Notifications are reconciliation hints, never a source of spendable entitlement.
// Every voucher issuance still queries Apple's current subscription status.
export function appleNotificationHandler({verifier,bundleID,environment,appAppleID,productIDs,hmacKey,record,now=()=>Date.now()}) {
  return async signedPayload => {
    let event, transaction;
    try {
      event=await verifier.verifyAndDecodeNotification(signedPayload);
      const data=event.data;
      if(event.version!=='2.0' || typeof event.notificationUUID!=='string' || !/^[a-f0-9-]{36}$/i.test(event.notificationUUID) || !Number.isSafeInteger(event.signedDate) || event.signedDate>now()+300000 || !data || data.bundleId!==bundleID || data.environment!==environment || (environment==='Production' && data.appAppleId!==appAppleID)) throw new Error('invalid');
      if(data.signedTransactionInfo) {
        transaction=await verifier.verifyAndDecodeTransaction(data.signedTransactionInfo);
        if(transaction.bundleId!==bundleID || transaction.environment!==environment || !productIDs.includes(transaction.productId) || transaction.type!=='Auto-Renewable Subscription' || typeof transaction.originalTransactionId!=='string') throw new Error('invalid');
      }
    } catch { throw new GatewayError(400,'notification_invalid'); }
    // Hash the UUID; persist no JWS, Apple transaction ID, email, or prompt.
    const digest=createHash('sha256').update(event.notificationUUID).digest('hex');
    const ledgerID=transaction?billingLedgerID(transaction.originalTransactionId,hmacKey):null;
    const type=typeof event.notificationType==='string' && /^[A-Z_]{1,64}$/.test(event.notificationType)?event.notificationType:'UNKNOWN';
    await record({digest,ledgerID,signedDate:event.signedDate,type,expiresAt:new Date(now()+90*86400000)});
  };
}

export function firestoreNotificationRecorder(database) {
  return event=>database.runTransaction(async tx=>{
    const receipt=database.collection('notificationReceipts').doc(event.digest);
    const seen=await tx.get(receipt);
    if(seen.exists) return;
    const state=event.ledgerID?database.collection('entitlementSignals').doc(event.ledgerID):null;
    const previous=state?await tx.get(state):null;
    // Late renewals cannot overwrite a newer refund/revocation signal.
    if(state && (!previous.exists || previous.data().signedDate<event.signedDate)) {
      tx.set(state,{signedDate:event.signedDate,type:event.type,expiresAt:event.expiresAt});
    }
    tx.create(receipt,{expiresAt:event.expiresAt});
  });
}
