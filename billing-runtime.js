import { DICTATION_ROUTE, DICTATION_UNITS } from './dictation.js';
import {COMMERCIAL_POLICY,validateSubscriptionTerms} from './commercial-policy.js';
import {readFile} from 'node:fs/promises';
import {createPrivateKey} from 'node:crypto';
import {initializeApp,applicationDefault} from 'firebase-admin/app';
import {getAppCheck} from 'firebase-admin/app-check';
import {getFirestore} from 'firebase-admin/firestore';
import {configuredAppleServices} from './apple-entitlement.js';
import {appleNotificationHandler,firestoreNotificationRecorder} from './apple-notifications.js';
import {firestoreAllowance,firestoreAllowanceReader,voucherIssuer} from './vouchers.js';
import {appleAppIdentityVerifier,firestoreTrialAllowance,trialIssuer} from './trial-access.js';
import {validateIssuerCreditPolicy} from './token-budget.js';
import {accessPolicy} from './access-policy.js';
import {createBillingServer} from './billing-server.js';
import {firestoreAttestationVerifier} from './admission.js';

async function start() {
  const billingProject=process.env.GOOGLE_CLOUD_PROJECT;
  const attestationProject=process.env.APP_CHECK_PROJECT_ID;
  const appIDs=JSON.parse(process.env.APP_CHECK_APP_IDS||'[]');
  if(!billingProject||!attestationProject||billingProject===attestationProject||!Array.isArray(appIDs)||!appIDs.length||!process.env.VOUCHER_KEY_ID||!process.env.VOUCHER_ISSUER||!process.env.VOUCHER_AUDIENCE) throw new Error('billing_configuration_missing');
  const config=JSON.parse(await readFile(process.env.APPLE_CONFIGURATION_FILE,'utf8'));
  validateIssuerCreditPolicy(config);
  validateSubscriptionTerms(config);
  const roots=await Promise.all(config.rootCertificateFiles.map(file=>readFile(file)));
  const signingKey=await readFile(process.env.APPLE_SIGNING_KEY_FILE,'utf8');
  const voucherKey=createPrivateKey(await readFile(process.env.VOUCHER_SIGNING_KEY_FILE,'utf8'));
  if(voucherKey.asymmetricKeyType!=='ed25519') throw new Error('billing_configuration_missing');
  const hmacKey=await readFile(process.env.LEDGER_HMAC_KEY_FILE);
  if(hmacKey.length<32) throw new Error('billing_configuration_missing');
  const billing=initializeApp({credential:applicationDefault(),projectId:billingProject},'billing');
  const databaseID=process.env.BILLING_DATABASE_ID;
  if(config.environment==='Sandbox' && (!databaseID || databaseID==='(default)')) throw new Error('sandbox_database_required');
  const database=databaseID ? getFirestore(billing,databaseID) : getFirestore(billing);
  const attestation=initializeApp({credential:applicationDefault(),projectId:attestationProject},'attestation');
  const {verifyTransaction,verifier}=configuredAppleServices({...config,rootCertificates:roots,signingKey});
  const dictationUnits = config.openAIDictation === true ? DICTATION_UNITS : undefined;
  const paidCosts = dictationUnits ? { ...config.routeCosts, [DICTATION_ROUTE.id]: dictationUnits } : config.routeCosts;
  const paid=voucherIssuer({verifyTransaction,reserve:firestoreAllowance(database),readAllowance:firestoreAllowanceReader(database),includeAllowance:true,privateKey:voucherKey,
    kid:process.env.VOUCHER_KEY_ID,issuer:process.env.VOUCHER_ISSUER,audience:process.env.VOUCHER_AUDIENCE,hmacKey,
    routeCosts:paidCosts,monthlyUnits:config.monthlyUnits,monthlyUnitsByProduct:config.monthlyUnitsByProduct});
  const trialPolicy=config.trial??COMMERCIAL_POLICY.trial;
  const trial=trialIssuer({verifyIdentity:appleAppIdentityVerifier({...config,verifier}),allowance:firestoreTrialAllowance(database,trialPolicy),privateKey:voucherKey,
    kid:process.env.VOUCHER_KEY_ID,issuer:process.env.VOUCHER_ISSUER,audience:process.env.VOUCHER_AUDIENCE,hmacKey,routeCosts:config.routeCosts,policy:trialPolicy});
  const selected=body=>Object.hasOwn(body,'signedTransaction')?paid:trial;
  const issue=body=>selected(body)(body),inspect=body=>selected(body).status(body);
  const notify=appleNotificationHandler({...config,verifier,hmacKey,record:firestoreNotificationRecorder(database)});
  const server=createBillingServer({appCheck:firestoreAttestationVerifier(getAppCheck(attestation),database,appIDs),allowedAppIDs:appIDs,issue,inspect,policy:accessPolicy(config,trialPolicy,dictationUnits),notify});
  server.listen(Number(process.env.PORT||8080),'0.0.0.0');
  process.on('SIGTERM',()=>{server.close();setTimeout(()=>process.exit(0),5000).unref();});
}
start().catch(()=>{process.exitCode=1;});
