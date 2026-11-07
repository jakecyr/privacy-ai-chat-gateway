import {createHash,createHmac,randomBytes,sign,verify} from 'node:crypto';
import {GatewayError} from './admission.js';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const decode = value => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('encoding');
  return JSON.parse(Buffer.from(value,'base64url').toString('utf8'));
};
const keysOnly = (value,keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every(k=>keys.includes(k));
export function issueVoucher({privateKey,kid,issuer,audience,route,expiresAt,now=Math.floor(Date.now()/1000)}) {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now+3600 || !kid || !issuer || !audience || !route) throw new Error('invalid_voucher_configuration');
  const header=encode({alg:'EdDSA',typ:'JWT',kid});
  const payload=encode({iss:issuer,aud:audience,iat:now,exp:expiresAt,nonce:randomBytes(32).toString('base64url'),route});
  const body=`${header}.${payload}`;
  return `${body}.${sign(null,Buffer.from(body),privateKey).toString('base64url')}`;
}
export function verifyVoucher(token,{publicKeys,issuer,audience,route,now=Math.floor(Date.now()/1000)}) {
  try {
    if (typeof token !== 'string' || token.length>4096) throw new Error('size');
    const parts=token.split('.');if(parts.length!==3) throw new Error('format');
    const [header,payload]=parts.slice(0,2).map(decode);
    if (!keysOnly(header,['alg','typ','kid']) || header.alg!=='EdDSA' || header.typ!=='JWT' || !Object.hasOwn(publicKeys,header.kid)) throw new Error('algorithm');
    const publicKey=publicKeys[header.kid];
    if (publicKey.asymmetricKeyType!=='ed25519') throw new Error('key');
    const signature=Buffer.from(parts[2],'base64url');
    if (signature.length!==64 || !verify(null,Buffer.from(parts.slice(0,2).join('.')),publicKey,signature)) throw new Error('signature');
    if (!keysOnly(payload,['iss','aud','iat','exp','nonce','route']) || payload.iss!==issuer || payload.aud!==audience || payload.route!==route || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat>now || payload.exp<=now || payload.exp<=payload.iat || payload.exp-payload.iat>3600 || typeof payload.nonce!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(payload.nonce)) throw new Error('claims');
    return {hash:createHash('sha256').update(payload.nonce).digest('hex'),expiresAt:payload.exp};
  } catch { throw new GatewayError(401,'access_invalid'); }
}
export function firestoreVoucherSpender(database,options) {
  return async (token,route) => {
    const {hash,expiresAt}=verifyVoucher(token,{...options,route:route.id});
    try { await database.collection('spentVouchers').doc(hash).create({expiresAt:new Date(expiresAt*1000)}); }
    catch (error) { if(error.code===6 || error.code==='already-exists') throw new GatewayError(401,'access_replayed'); throw new GatewayError(503,'access_unavailable'); }
  };
}
export function billingLedgerID(originalTransactionID,hmacKey) {
  if (!hmacKey || typeof originalTransactionID!=='string' || !originalTransactionID.length) throw new Error('invalid_ledger_configuration');
  return createHmac('sha256',hmacKey).update(originalTransactionID).digest('hex');
}

// Lives only in the billing project. Call after authoritative transaction verification.
export function firestoreAllowance(database) {
  return async ({ledgerID,window,units,limit}) => database.runTransaction(async tx=>{
    if(!/^[a-f0-9]{64}$/.test(ledgerID) || !/^\d{4}-\d{2}$/.test(window) || !Number.isSafeInteger(units) || units<1 || units>10000000 || !Number.isSafeInteger(limit) || limit<units) throw new GatewayError(400,'invalid_allowance');
    const reference=database.collection('allowances').doc(`${ledgerID}-${window}`);
    const record=await tx.get(reference);const reserved=record.exists?record.data().reserved:0;
    if(!Number.isSafeInteger(reserved)||reserved<0) throw new GatewayError(503,'allowance_unavailable');
    if(reserved+units>limit) throw new GatewayError(429,'allowance_exhausted');
    tx.set(reference,{reserved:reserved+units});
  });
}
export function voucherIssuer({verifyTransaction,reserve,privateKey,kid,issuer,audience,hmacKey,routeCosts,monthlyUnits,now=()=>Math.floor(Date.now()/1000)}) {
  if (!Number.isSafeInteger(monthlyUnits) || monthlyUnits < 1 || monthlyUnits > 1000000000 || !routeCosts || !Object.keys(routeCosts).length || Object.values(routeCosts).some(cost=>!Number.isSafeInteger(cost)||cost<1||cost*5>10000000)) throw new Error('invalid_credit_configuration');
  const costs = Object.freeze({...routeCosts});
  return async ({signedTransaction,route,count=1})=>{
    if(typeof signedTransaction!=='string'||signedTransaction.length>32768||!Object.hasOwn(costs,route)||!Number.isSafeInteger(count)||count<1||count>5) throw new GatewayError(400,'invalid_request');
    // The verifier owns chain, app, product, environment, renewal and revocation checks.
    const entitlement=await verifyTransaction(signedTransaction);
    const timestamp=now();
    if(!entitlement?.active || !Number.isSafeInteger(entitlement.expiresAt)||entitlement.expiresAt<=timestamp || !entitlement.originalTransactionID) throw new GatewayError(403,'subscription_inactive');
    const ledgerID=billingLedgerID(entitlement.originalTransactionID,hmacKey);
    const window=new Date(timestamp*1000).toISOString().slice(0,7);
    await reserve({ledgerID,window,units:count*costs[route],limit:monthlyUnits});
    const expiresAt=Math.min(timestamp+3600,entitlement.expiresAt);
    // Lost issuer responses waste reserved allowance. Never issue replacement vouchers speculatively.
    return Array.from({length:count},()=>issueVoucher({privateKey,kid,issuer,audience,route,expiresAt,now:timestamp}));
  };
}
