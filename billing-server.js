import {createHash} from 'node:crypto';
import http from 'node:http';
import {GatewayError,verifyAttestation} from './admission.js';
import {abortable,readJSON} from './http-boundaries.js';
import {legacyCompatibleRoute} from './route-specs.js';
import {DICTATION_ROUTE} from './dictation.js';

export function createBillingServer({appCheck,allowedAppIDs,issue,inspect,policy,notify,deadlineMS=30000}) {
  if(!appCheck || !allowedAppIDs?.length || !issue) throw new Error('billing_configuration_missing');
  if(!Number.isInteger(deadlineMS)||deadlineMS<1||deadlineMS>30000) throw new Error('invalid_deadline');
  const encodedPolicy=policy?JSON.stringify(policy):null;
  const policyTag=encodedPolicy?'"'+createHash('sha256').update(encodedPolicy).digest('hex')+'"':null;
  const legacyPolicy=policy?.routes?{...policy,routes:policy.routes.filter(legacyCompatibleRoute)}:policy;
  const encodedLegacyPolicy=legacyPolicy?JSON.stringify(legacyPolicy):null;
  const legacyPolicyTag=encodedLegacyPolicy?'"'+createHash('sha256').update(encodedLegacyPolicy).digest('hex')+'"':null;
  const server=http.createServer(async(request,response)=>{
    const abort=new AbortController();
    const timeout=setTimeout(()=>abort.abort(),deadlineMS);timeout.unref();
    response.on('close',()=>abort.abort());
    response.on('finish',()=>{if(!request.complete)request.destroy();});
    try {
      const modern=request.headers['x-privatechat-model-policy']==='2';
      const currentPolicy=modern?policy:legacyPolicy;
      const currentPolicyTag=modern?policyTag:legacyPolicyTag;
      if(request.method==='GET' && request.url==='/v1/access/policy' && policy) {
        response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store','ETag':currentPolicyTag,'Vary':'X-PrivateChat-Model-Policy'});response.end(modern?encodedPolicy:encodedLegacyPolicy);return;
      }
      const status=request.url==='/v1/access/status' && inspect;
      const notification=request.url==='/v1/apple/notifications' && notify;
      if(request.method!=='POST'||(request.url!=='/v1/access/issue'&&!status&&!notification)) throw new GatewayError(404,'not_found');
      if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type']||'')||request.headers['content-encoding']) throw new GatewayError(415,'invalid_request');
      if(Number(request.headers['content-length'])>49152) throw new GatewayError(413,'invalid_request');
      // Apple authenticates notifications with a verified JWS, not an app token.
      if(!notification) await abortable(()=>verifyAttestation(appCheck,request.headers['x-firebase-appcheck'],allowedAppIDs),abort.signal);
      const body=await readJSON(request,{limit:49152,signal:abort.signal});
      if(notification) {
        if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||typeof body.signedPayload!=='string'||!body.signedPayload.length||body.signedPayload.length>45000) throw new GatewayError(400,'invalid_request');
        await abortable(()=>notify(body.signedPayload),abort.signal);
        response.writeHead(200,{'Cache-Control':'no-store'});response.end();return;
      }
      const credential=body && Object.hasOwn(body,'signedTransaction')?'signedTransaction':'signedAppTransaction';
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==3||!Object.keys(body).every(k=>[credential,'route','count'].includes(k)) || typeof body[credential]!=='string'||!body[credential].length||body[credential].length>32768||typeof body.route!=='string'||!/^[a-z0-9-]{1,80}$/.test(body.route)||!Number.isSafeInteger(body.count)||body.count<1||body.count>5) throw new GatewayError(400,'invalid_request');
      if(currentPolicyTag && request.headers['if-match']!==currentPolicyTag)throw new GatewayError(412,'access_policy_changed');
      if(currentPolicy?.routes && !currentPolicy.routes.some(route=>route.id===body.route) && !(currentPolicy.dictationUnits && body.route===DICTATION_ROUTE.id))throw new GatewayError(400,'invalid_request');
      if(status) {
        const allowance=await abortable(()=>inspect(body),abort.signal);
        response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify({allowance}));return;
      }
      const result=await abortable(()=>issue(body),abort.signal);
      const tokens=Array.isArray(result)?result:result.tokens;
      const vouchers=tokens.map(token=>{
        // Tokens were just signed by this issuer; decode only to expose wallet expiry metadata.
        const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));
        return {token,route:claims.route,expiresAt:claims.exp};
      });
      response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify({vouchers,...(result.allowance?{allowance:result.allowance}:{})}));
    } catch(error) {
      if(response.destroyed||response.writableEnded)return;
      const known=error instanceof GatewayError;
      response.writeHead(known?error.status:503,{'Content-Type':'application/json','Cache-Control':'no-store'});
      response.end(JSON.stringify({error:known?error.code:'billing_unavailable'}));
    } finally {clearTimeout(timeout);abort.abort();}
    // Signed transactions and entitlement identifiers never enter logging or the chat service.
  });
  server.requestTimeout=35000;server.headersTimeout=10000;
  return server;
}
