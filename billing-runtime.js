import {readFile} from 'node:fs/promises';
import {createPrivateKey} from 'node:crypto';
import {initializeApp,applicationDefault} from 'firebase-admin/app';
import {getAppCheck} from 'firebase-admin/app-check';
import {getFirestore} from 'firebase-admin/firestore';
import {configuredAppleServices} from './apple-entitlement.js';
import {appleNotificationHandler,firestoreNotificationRecorder} from './apple-notifications.js';
import {firestoreAllowance,voucherIssuer} from './vouchers.js';
import {createBillingServer} from './billing-server.js';

async function start() {
  const billingProject=process.env.GOOGLE_CLOUD_PROJECT;
  const attestationProject=process.env.APP_CHECK_PROJECT_ID;
  const appIDs=JSON.parse(process.env.APP_CHECK_APP_IDS||'[]');
  if(!billingProject||!attestationProject||billingProject===attestationProject||!appIDs.length) throw new Error('billing_configuration_missing');
  const config=JSON.parse(await readFile(process.env.APPLE_CONFIGURATION_FILE,'utf8'));
  const roots=await Promise.all(config.rootCertificateFiles.map(file=>readFile(file)));
  const signingKey=await readFile(process.env.APPLE_SIGNING_KEY_FILE,'utf8');
  const voucherKey=createPrivateKey(await readFile(process.env.VOUCHER_SIGNING_KEY_FILE,'utf8'));
  if(voucherKey.asymmetricKeyType!=='ed25519') throw new Error('billing_configuration_missing');
  const hmacKey=await readFile(process.env.LEDGER_HMAC_KEY_FILE);
  if(hmacKey.length<32) throw new Error('billing_configuration_missing');
  const billing=initializeApp({credential:applicationDefault(),projectId:billingProject},'billing');
  const attestation=initializeApp({credential:applicationDefault(),projectId:attestationProject},'attestation');
  const {verifyTransaction,verifier}=configuredAppleServices({...config,rootCertificates:roots,signingKey});
  const issue=voucherIssuer({verifyTransaction,reserve:firestoreAllowance(getFirestore(billing)),privateKey:voucherKey,
    kid:process.env.VOUCHER_KEY_ID,issuer:process.env.VOUCHER_ISSUER,audience:process.env.VOUCHER_AUDIENCE,hmacKey,
    routeCosts:config.routeCosts,monthlyUnits:config.monthlyUnits});
  const notify=appleNotificationHandler({...config,verifier,hmacKey,record:firestoreNotificationRecorder(getFirestore(billing))});
  const server=createBillingServer({appCheck:getAppCheck(attestation),allowedAppIDs:appIDs,issue,notify});
  server.listen(Number(process.env.PORT||8080),'0.0.0.0');
  process.on('SIGTERM',()=>{server.close();setTimeout(()=>process.exit(0),5000).unref();});
}
start().catch(()=>{process.exitCode=1;});
