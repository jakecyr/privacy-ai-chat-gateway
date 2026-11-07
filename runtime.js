import {readFile} from 'node:fs/promises';
import {createPublicKey} from 'node:crypto';
import {initializeApp,applicationDefault} from 'firebase-admin/app';
import {getAppCheck} from 'firebase-admin/app-check';
import {getFirestore} from 'firebase-admin/firestore';
import {createProductionServer} from './production-server.js';
import {DailyQuota,firestoreReservation,cachedConfiguration} from './admission.js';
import {firestoreVoucherSpender,verifyVoucher} from './vouchers.js';
import {openAIAdapter} from './openai-adapter.js';

async function start() {
  const projectID=process.env.GOOGLE_CLOUD_PROJECT;
  const appIDs=JSON.parse(process.env.APP_CHECK_APP_IDS || '[]');
  if(!projectID || !Array.isArray(appIDs) || !appIDs.length || !appIDs.every(id=>typeof id==='string')) throw new Error('configuration_missing');
  const keyFile=process.env.OPENAI_KEY_FILE;
  const publicKeyFile=process.env.VOUCHER_PUBLIC_KEYS_FILE;
  if(!keyFile || !publicKeyFile || !process.env.VOUCHER_ISSUER || !process.env.VOUCHER_AUDIENCE) throw new Error('configuration_missing');
  const encodedKeys=JSON.parse(await readFile(publicKeyFile,'utf8'));
  const publicKeys=Object.fromEntries(Object.entries(encodedKeys).map(([kid,pem])=>[kid,createPublicKey(pem)]));
  if(!Object.keys(publicKeys).length || Object.values(publicKeys).some(key=>key.asymmetricKeyType!=='ed25519')) throw new Error('configuration_missing');
  const app=initializeApp({credential:applicationDefault(),projectId:projectID});
  const database=getFirestore(app);
  const quota=new DailyQuota({reserve:firestoreReservation(database)});
  const configuration=cachedConfiguration(async()=>{
      const snapshot=await database.doc('runtime/gateway').get();
      if(!snapshot.exists) throw new Error();
      return snapshot.data();
  });
  const server=createProductionServer({
    appCheck:getAppCheck(app),allowedAppIDs:appIDs,configuration,quota,
    generate:openAIAdapter({apiKey:(await readFile(keyFile,'utf8')).trim()}),
    validateVoucher:(token,route)=>verifyVoucher(token,{publicKeys,issuer:process.env.VOUCHER_ISSUER,audience:process.env.VOUCHER_AUDIENCE,route:route.id}),
    spendVoucher:firestoreVoucherSpender(database,{publicKeys,issuer:process.env.VOUCHER_ISSUER,audience:process.env.VOUCHER_AUDIENCE}),
  });
  const port=Number(process.env.PORT || 8080);
  if(!Number.isInteger(port)||port<1||port>65535) throw new Error('configuration_missing');
  server.listen(port,'0.0.0.0');
  const shutdown=()=>{server.close();setTimeout(()=>process.exit(0),5000).unref();};
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
// Never print raw startup exceptions or credentials.
start().catch(()=>{process.exitCode=1;});
