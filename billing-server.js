import http from 'node:http';
import {GatewayError,verifyAttestation} from './admission.js';
import {abortable,readJSON} from './http-boundaries.js';

export function createBillingServer({appCheck,allowedAppIDs,issue,notify,deadlineMS=30000}) {
  if(!appCheck || !allowedAppIDs?.length || !issue) throw new Error('billing_configuration_missing');
  if(!Number.isInteger(deadlineMS)||deadlineMS<1||deadlineMS>30000) throw new Error('invalid_deadline');
  const server=http.createServer(async(request,response)=>{
    const abort=new AbortController();
    const timeout=setTimeout(()=>abort.abort(),deadlineMS);timeout.unref();
    response.on('close',()=>abort.abort());
    response.on('finish',()=>{if(!request.complete)request.destroy();});
    try {
      const notification=request.url==='/v1/apple/notifications' && notify;
      if(request.method!=='POST'||(request.url!=='/v1/access/issue'&&!notification)) throw new GatewayError(404,'not_found');
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
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==3||!Object.keys(body).every(k=>['signedTransaction','route','count'].includes(k))) throw new GatewayError(400,'invalid_request');
      const tokens=await abortable(()=>issue(body),abort.signal);
      const vouchers=tokens.map(token=>{
        // Tokens were just signed by this issuer; decode only to expose wallet expiry metadata.
        const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));
        return {token,route:claims.route,expiresAt:claims.exp};
      });
      response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify({vouchers}));
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
