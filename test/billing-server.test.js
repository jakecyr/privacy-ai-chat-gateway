import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {createBillingServer} from '../billing-server.js';
import {issueVoucher} from '../vouchers.js';

test('billing endpoint requires attestation and strict billing-only payload',async t=>{
 let issued=0;const {privateKey}=generateKeyPairSync('ed25519');
 const server=createBillingServer({appCheck:{verifyToken:async token=>({appId:token==='valid'?'app':'other'})},allowedAppIDs:['app'],issue:async body=>{
  issued++;assert.equal(body.signedTransaction,'synthetic');return [issueVoucher({privateKey,kid:'v1',issuer:'billing',audience:'chat',route:'terra',now:1000,expiresAt:2000})];
 }});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const url=`http://127.0.0.1:${server.address().port}/v1/access/issue`;
 const body={signedTransaction:'synthetic',route:'terra',count:1};
 const post=(payload,token='valid')=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Firebase-AppCheck':token},body:JSON.stringify(payload)});
 assert.equal((await post(body,'invalid')).status,401);
 assert.equal((await post({...body,messages:[{role:'user',text:'PRIVATE_PROMPT'}]})).status,400);
 assert.equal(issued,0);
 const response=await post(body);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 const data=await response.json();assert.equal(data.vouchers[0].expiresAt,2000);assert.equal(data.vouchers[0].route,'terra');assert.equal(issued,1);
});
