import http from 'node:http';
import { once } from 'node:events';
import { GatewayError, activeRoute, publicModels, validateRequest, verifyAttestation } from './admission.js';
import {validateProviderInputBudget} from './provider-dispatcher.js';
import {abortable,readJSON,textChunks} from './http-boundaries.js';

// All production dependencies are explicit; no development verifier can be selected by request data.
export function createProductionServer({appCheck, allowedAppIDs, configuration, quota, generate, validateVoucher, spendVoucher,deadlineMS=60000}) {
  if (!appCheck || !allowedAppIDs?.length || !configuration || !quota || !generate || !validateVoucher || !spendVoucher) throw new Error('missing_dependencies');
  if(!Number.isInteger(deadlineMS)||deadlineMS<1||deadlineMS>60000) throw new Error('invalid_deadline');
  const server = http.createServer(async (request,response) => {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(),deadlineMS); timeout.unref();
    response.on('close',() => abort.abort());
    response.on('finish',()=>{if(!request.complete)request.destroy();});
    let lastWrite=Date.now(),iterator;
    const send = async (event,data) => {
      if (abort.signal.aborted || response.destroyed) throw new GatewayError(503,'upstream_timeout');
      if (!response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) await once(response,'drain',{signal:abort.signal});
      lastWrite=Date.now();
    };
    let heartbeat;
    try {
      if (request.method === 'GET' && request.url === '/health') { response.writeHead(200,{'Cache-Control':'no-store'}); response.end('ready'); return; }
      if (request.method === 'GET' && request.url === '/v1/models') {
        const models=publicModels(await abortable(configuration,abort.signal));
        response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify(models));return;
      }
      const connectionCheck=request.url==='/v1/attestation/check';
      if (request.method !== 'POST' || (request.url !== '/v1/chat/stream' && !connectionCheck)) throw new GatewayError(404,'not_found');
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '') || request.headers['content-encoding']) throw new GatewayError(415,'invalid_request');
      if (Number(request.headers['content-length']) > (connectionCheck?256:32768)) throw new GatewayError(413,'invalid_request');
      // Attestation is consumed before parsing or acting on any prompt fields.
      await abortable(()=>verifyAttestation(appCheck,request.headers['x-firebase-appcheck'],allowedAppIDs),abort.signal);
      if(connectionCheck) {
        const body=await readJSON(request,{limit:256,signal:abort.signal});
        if(!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).length)throw new GatewayError(400,'invalid_request');
        response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
        response.end(JSON.stringify({verified:true}));return;
      }
      const body=validateRequest(await readJSON(request,{limit:32768,signal:abort.signal}));
      const route = activeRoute(await abortable(configuration,abort.signal),body.route);
      if (body.disclosureVersion !== route.disclosureVersion) throw new GatewayError(409,'disclosure_changed');
      validateProviderInputBudget(route,body);
      const authorization = request.headers.authorization;
      if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ') || authorization.length > 8192) throw new GatewayError(401,'access_required');
      // Invalid signatures must not drain fleet admission credits.
      await abortable(()=>validateVoucher(authorization.slice(7),route),abort.signal);
      if(abort.signal.aborted) throw new GatewayError(503,'upstream_timeout');
      // Spending is conservative: failed attempts may consume a voucher and a quota credit.
      await abortable(()=>quota.take(),abort.signal);
      await abortable(()=>spendVoucher(authorization.slice(7),route),abort.signal);
      if(abort.signal.aborted) throw new GatewayError(503,'upstream_timeout');
      response.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});
      await send('meta',{route:route.id,disclosureVersion:route.disclosureVersion});
      heartbeat = setInterval(() => { if (Date.now()-lastWrite>=15000 && !response.writableNeedDrain && !response.destroyed) { response.write(': heartbeat\n\n');lastWrite=Date.now(); } },15000); heartbeat.unref();
      let count = 0, terminal = false;
      iterator=generate(route,body,abort.signal)[Symbol.asyncIterator]();
      while(true) {
        const {done,value:event}=await abortable(()=>iterator.next(),abort.signal);
        if(done)break;
        if (terminal) throw new GatewayError(503,'upstream_failure');
        if (event.type === 'delta' && typeof event.text === 'string') {
          count += Buffer.byteLength(event.text);
          if (count > 65536) throw new GatewayError(503,'output_limit');
          for(const text of textChunks(event.text)) await send('delta',{text});
        } else if (event.type === 'done' && ['stop','length'].includes(event.reason)) {
          terminal = true; await send('done',{reason:event.reason}); break;
        } else throw new GatewayError(503,'upstream_failure');
      }
      if (!terminal) throw new GatewayError(503,'upstream_failure');
      response.end();
    } catch (error) {
      if(response.destroyed||response.writableEnded)return;
      const known = error instanceof GatewayError;
      const code = known && ['upstream_timeout','content_blocked','route_unavailable'].includes(error.code) ? error.code : 'upstream_failure';
      if (!response.headersSent) {
        const headers = {'Content-Type':'application/json','Cache-Control':'no-store'};
        if (known && error.retryAfter) headers['Retry-After'] = String(error.retryAfter);
        response.writeHead(known ? error.status : 503,headers);
        response.end(JSON.stringify({error:known ? error.code : 'service_unavailable'}));
      } else if (!response.destroyed) {
        response.end(`event: error\ndata: ${JSON.stringify({code})}\n\n`);
      }
      // No exception objects, request IDs, headers, IP addresses or content are logged.
    } finally {
      clearTimeout(timeout); clearInterval(heartbeat); abort.abort();
      // Do not let an uncooperative iterator prevent HTTP teardown.
      if(iterator?.return) Promise.resolve().then(()=>iterator.return()).catch(()=>{});
    }
  });
  server.requestTimeout = 70000; server.headersTimeout = 10000;
  return server;
}
