import {Environment,SignedDataVerifier,AppStoreServerAPIClient} from '@apple/app-store-server-library';
import {GatewayError} from './admission.js';

export function appleEntitlementVerifier({verifier,api,bundleID,productIDs,environment,now=()=>Date.now()}) {
  const check = transaction => {
    if (transaction.bundleId!==bundleID || transaction.environment!==environment || !productIDs.includes(transaction.productId) || transaction.type!=='Auto-Renewable Subscription' || transaction.revocationDate || !transaction.originalTransactionId) throw new GatewayError(403,'subscription_inactive');
    return transaction;
  };
  return async signedTransaction => {
    try {
      const presented=check(await verifier.verifyAndDecodeTransaction(signedTransaction));
      // A valid old signature does not establish current entitlement. Reconcile each issuance.
      const status=await api.getAllSubscriptionStatuses(presented.originalTransactionId);
      if (status.bundleId!==bundleID || status.environment!==environment) throw new GatewayError(403,'subscription_inactive');
      for(const group of status.data ?? []) for(const item of group.lastTransactions ?? []) {
        if (![1,4].includes(item.status) || !item.signedTransactionInfo) continue;
        const current=check(await verifier.verifyAndDecodeTransaction(item.signedTransactionInfo));
        if (current.originalTransactionId!==presented.originalTransactionId) continue;
        if(typeof current.transactionId!=='string' || !current.transactionId.length || current.transactionId.length>256 ||
           !Number.isSafeInteger(current.purchaseDate) || current.purchaseDate<=0 || current.purchaseDate>now() ||
           !Number.isSafeInteger(current.expiresDate) || current.expiresDate<=current.purchaseDate) continue;
        let expiresAt=current.expiresDate;
        if(item.status===4) {
          if(!item.signedRenewalInfo) continue;
          const renewal=await verifier.verifyAndDecodeRenewalInfo(item.signedRenewalInfo);
          if(renewal.originalTransactionId!==current.originalTransactionId || renewal.environment!==environment) continue;
          expiresAt=renewal.gracePeriodExpiresDate;
        }
        if(!Number.isSafeInteger(expiresAt)||expiresAt<=now()) continue;
        return {active:true,originalTransactionID:current.originalTransactionId,periodTransactionID:current.transactionId,periodEndsAt:Math.floor(current.expiresDate/1000),inGracePeriod:item.status===4,expiresAt:Math.floor(expiresAt/1000)};
      }
      throw new GatewayError(403,'subscription_inactive');
    } catch(error) {
      if(error instanceof GatewayError) throw error;
      throw new GatewayError(503,'subscription_verification_unavailable');
    }
  };
}

export function configuredAppleVerifier({rootCertificates,environment,bundleID,appAppleID,signingKey,keyID,issuerID,productIDs}) {
  return configuredAppleServices({rootCertificates,environment,bundleID,appAppleID,signingKey,keyID,issuerID,productIDs}).verifyTransaction;
}

export function configuredAppleServices({rootCertificates,environment,bundleID,appAppleID,signingKey,keyID,issuerID,productIDs}) {
  if(![Environment.PRODUCTION,Environment.SANDBOX].includes(environment) || !rootCertificates?.length || !bundleID || !productIDs?.length || !signingKey || !keyID || !issuerID || (environment===Environment.PRODUCTION&&!Number.isSafeInteger(appAppleID))) throw new Error('apple_configuration_missing');
  const verifier=new SignedDataVerifier(rootCertificates,true,environment,bundleID,appAppleID);
  const api=new AppStoreServerAPIClient(signingKey,keyID,issuerID,bundleID,environment);
  return {verifier,verifyTransaction:appleEntitlementVerifier({verifier,api,bundleID,productIDs,environment})};
}
