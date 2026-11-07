import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {issueVoucher,verifyVoucher,firestoreVoucherSpender,voucherIssuer,firestoreAllowance} from '../vouchers.js';
const {publicKey,privateKey}=generateKeyPairSync('ed25519');
const configuration={issuer:'billing',audience:'chat',route:'terra',publicKeys:{v1:publicKey}};
const issue=(extra={})=>issueVoucher({privateKey,kid:'v1',issuer:'billing',audience:'chat',route:'terra',now:1000,expiresAt:2000,...extra});
test('vouchers contain no subscription identity and reject tamper, wrong route, expiry, future issuance',()=>{
 const token=issue();const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url'));
 assert.deepEqual(Object.keys(claims).sort(),['iss','aud','iat','exp','nonce','route'].sort());
 assert.equal(verifyVoucher(token,{...configuration,now:1001}).expiresAt,2000);
 for(const options of [{now:2000},{now:999},{now:1001,route:'expensive'},{now:1001,audience:'other'}]) assert.throws(()=>verifyVoucher(token,{...configuration,...options}));
 assert.throws(()=>verifyVoucher(token.slice(0,-4)+'AAAA',{...configuration,now:1001}));
});
test('atomic spent nonce creation rejects concurrent replay and writes only expiry',async()=>{
 const records=new Map();
 const database={collection:name=>{assert.equal(name,'spentVouchers');return {doc:hash=>({create:async value=>{if(records.has(hash)){const error=new Error();error.code=6;throw error;}records.set(hash,value);}})};}};
 const timestamp=Math.floor(Date.now()/1000);const token=issue({now:timestamp,expiresAt:timestamp+3600});
 const spend=firestoreVoucherSpender(database,configuration);
 const results=await Promise.allSettled(Array.from({length:20},()=>spend(token,{id:'terra'})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(records.size,1);
 assert.deepEqual(Object.keys([...records.values()][0]),['expiresAt']);
});
test('issuer reserves allowance before signing and binds all vouchers to verified subscription window',async()=>{
 const reservations=[];
 const issuer=voucherIssuer({verifyTransaction:async()=>({active:true,expiresAt:1500,originalTransactionID:'PRIVATE_TRANSACTION'}),reserve:async value=>reservations.push(value),privateKey,kid:'v1',issuer:'billing',audience:'chat',hmacKey:'test-secret',routeCosts:{terra:10},monthlyUnits:100,now:()=>1000});
 const tokens=await issuer({signedTransaction:'synthetic-signed-transaction',route:'terra',count:5});
 assert.equal(tokens.length,5);assert.equal(reservations.length,1);assert.equal(reservations[0].units,50);
 assert.match(reservations[0].ledgerID,/^[a-f0-9]{64}$/);
 assert.equal(JSON.stringify(reservations).includes('PRIVATE_TRANSACTION'),false);
 assert.equal(new Set(tokens.map(token=>verifyVoucher(token,{...configuration,now:1001}).hash)).size,5);
 for(const token of tokens) assert.equal(verifyVoucher(token,{...configuration,now:1001}).expiresAt,1500);
 await assert.rejects(issuer({signedTransaction:'x',route:'terra',count:6}));
});
test('inactive subscription and failed allowance reservation issue no vouchers',async()=>{
 let reserved=0;
 const issuer=voucherIssuer({verifyTransaction:async()=>({active:false}),reserve:async()=>reserved++,privateKey,kid:'v1',issuer:'billing',audience:'chat',hmacKey:'secret',routeCosts:{terra:10},monthlyUnits:100,now:()=>1000});
 await assert.rejects(issuer({signedTransaction:'x',route:'terra'}));assert.equal(reserved,0);
});

test('weighted route reservations share one subscription ledger across devices',async()=>{
 const records=new Map();let queue=Promise.resolve();
 const database={collection:name=>({doc:id=>({name,id})}),runTransaction:operation=>{
  const result=queue.then(()=>operation({get:async ref=>({exists:records.has(ref.id),data:()=>records.get(ref.id)}),set:(ref,value)=>records.set(ref.id,value)}));
  queue=result.catch(()=>{});return result;
 }};
 const options={verifyTransaction:async()=>({active:true,expiresAt:3000,originalTransactionID:'same-subscription'}),reserve:firestoreAllowance(database),privateKey,kid:'v1',issuer:'billing',audience:'chat',hmacKey:'test-secret',routeCosts:{economy:10,reasoning:30},monthlyUnits:100,now:()=>1000};
 const deviceA=voucherIssuer(options),deviceB=voucherIssuer(options);
 await deviceA({signedTransaction:'verified',route:'reasoning',count:2});
 await deviceB({signedTransaction:'verified',route:'economy',count:4});
 await assert.rejects(deviceA({signedTransaction:'verified',route:'economy',count:1}),error=>error.code==='allowance_exhausted');
 assert.equal(records.size,1);assert.equal([...records.values()][0].reserved,100);
});
test('concurrent weighted issuance cannot overspend and failed reservations sign nothing',async()=>{
 let reserved=0;let queue=Promise.resolve();
 const reserve=({units,limit})=>{const result=queue.then(()=>{if(reserved+units>limit)throw new Error('exhausted');reserved+=units;});queue=result.catch(()=>{});return result;};
 const issuer=voucherIssuer({verifyTransaction:async()=>({active:true,expiresAt:3000,originalTransactionID:'subscription'}),reserve,privateKey,kid:'v1',issuer:'billing',audience:'chat',hmacKey:'test-secret',routeCosts:{terra:30},monthlyUnits:100,now:()=>1000});
 const results=await Promise.allSettled(Array.from({length:20},()=>issuer({signedTransaction:'verified',route:'terra'})));
 assert.equal(results.filter(result=>result.status==='fulfilled').length,3);assert.equal(reserved,90);
});
