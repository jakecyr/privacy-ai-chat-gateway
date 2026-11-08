import {readFile} from 'node:fs/promises';
import {createHash,createPublicKey} from 'node:crypto';
import {initializeApp,applicationDefault} from 'firebase-admin/app';
import {getAppCheck} from 'firebase-admin/app-check';
import {getFirestore} from 'firebase-admin/firestore';
import {createProductionServer,createAttestationOnlyServer} from './production-server.js';
import {DailyQuota,firestoreReservation,cachedConfiguration} from './admission.js';
import {firestoreVoucherSpender,verifyVoucher} from './vouchers.js';
import {openAIAdapter} from './openai-adapter.js';
import {claudeAdapter} from './claude-adapter.js';
import {geminiAdapter} from './gemini-adapter.js';
import {GoogleAuth} from 'google-auth-library';
import {createProviderDispatcher} from './provider-dispatcher.js';
import {OPENAI_SPEC,CLAUDE_SPEC,GEMINI_SPEC,providerTargetDigest} from './route-specs.js';

async function start() {
  const projectID=process.env.GOOGLE_CLOUD_PROJECT;
  const appIDs=JSON.parse(process.env.APP_CHECK_APP_IDS || '[]');
  if(!projectID || !Array.isArray(appIDs) || !appIDs.length || !appIDs.every(id=>typeof id==='string')) throw new Error('configuration_missing');
  if(process.env.ATTESTATION_CHECK_ONLY && process.env.ATTESTATION_CHECK_ONLY!=='true')throw new Error('configuration_missing');
  if(process.env.ATTESTATION_CHECK_ONLY==='true') {
    const app=initializeApp({credential:applicationDefault(),projectId:projectID});
    listen(createAttestationOnlyServer({appCheck:getAppCheck(app),allowedAppIDs:appIDs}));return;
  }
  const keyFile=process.env.OPENAI_KEY_FILE;
  const publicKeyFile=process.env.VOUCHER_PUBLIC_KEYS_FILE;
  if(!publicKeyFile || !process.env.VOUCHER_ISSUER || !process.env.VOUCHER_AUDIENCE) throw new Error('configuration_missing');
  const encodedKeys=JSON.parse(await readFile(publicKeyFile,'utf8'));
  const publicKeys=Object.fromEntries(Object.entries(encodedKeys).map(([kid,pem])=>[kid,createPublicKey(pem)]));
  if(!Object.keys(publicKeys).length || Object.values(publicKeys).some(key=>key.asymmetricKeyType!=='ed25519')) throw new Error('configuration_missing');
  const app=initializeApp({credential:applicationDefault(),projectId:projectID});
  const database=getFirestore(app);
  const quota=new DailyQuota({reserve:firestoreReservation(database)});
  const registrations=new Map();
  const disable=()=>database.doc('runtime/gateway').update({enabled:false,disabledFor:'provider_contract'});
  const register=(spec,generate,target)=>{const registration={generate,target,targetDigest:providerTargetDigest(spec,target)};registrations.set(spec.id,registration);registrations.set(spec.provider,registration);};
  const readCredential=async path=>(await readFile(path,'utf8')).trim();
  const fingerprint=key=>createHash('sha256').update(key).digest('hex');
  if(keyFile) {
    const key=await readCredential(keyFile);
    register(OPENAI_SPEC,openAIAdapter({apiKey:key,onUsageViolation:disable}),{credentialSHA256:fingerprint(key)});
  }
  if(process.env.CLAUDE_KEY_FILE) {
    const key=await readCredential(process.env.CLAUDE_KEY_FILE);
    register(CLAUDE_SPEC,claudeAdapter({apiKey:key,onContractViolation:disable}),{credentialSHA256:fingerprint(key)});
  }
  if(process.env.GEMINI_CONFIGURATION_FILE) {
    const target=JSON.parse(await readFile(process.env.GEMINI_CONFIGURATION_FILE,'utf8'));
    if(Object.keys(target).length!==2 || !Object.keys(target).every(key=>['projectID','location'].includes(key)))throw new Error('configuration_missing');
    const auth=new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']});
    register(GEMINI_SPEC,geminiAdapter({...target,getAccessToken:()=>auth.getAccessToken(),onContractViolation:disable}),target);
  }
  if(!registrations.size)throw new Error('provider_configuration_missing');
  const dispatcher=createProviderDispatcher(registrations);
  const configuration=dispatcher.configuration(cachedConfiguration(async()=>{
      const snapshot=await database.doc('runtime/gateway').get();
      if(!snapshot.exists) throw new Error();
      return snapshot.data();
  }));
  const server=createProductionServer({
    appCheck:getAppCheck(app),allowedAppIDs:appIDs,configuration,quota,
    generate:dispatcher.generate,
    validateVoucher:(token,route)=>verifyVoucher(token,{publicKeys,issuer:process.env.VOUCHER_ISSUER,audience:process.env.VOUCHER_AUDIENCE,route:route.id}),
    spendVoucher:firestoreVoucherSpender(database,{publicKeys,issuer:process.env.VOUCHER_ISSUER,audience:process.env.VOUCHER_AUDIENCE}),
  });
  listen(server);
}
function listen(server) {
  const port=Number(process.env.PORT || 8080);
  if(!Number.isInteger(port)||port<1||port>65535) throw new Error('configuration_missing');
  server.listen(port,'0.0.0.0');
  const shutdown=()=>{server.close();setTimeout(()=>process.exit(0),5000).unref();};
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
// Never print raw startup exceptions or credentials.
start().catch(()=>{process.exitCode=1;});
