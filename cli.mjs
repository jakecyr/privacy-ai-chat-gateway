import {once} from 'node:events';

// Prompt text comes from stdin so it does not enter process arguments or shell history.
const origin=new URL(process.env.CHAT_ORIGIN||'http://127.0.0.1:8787');
if(origin.username||origin.password||origin.search||origin.hash||!['','/'].includes(origin.pathname)||!(origin.protocol==='https:'||(origin.protocol==='http:'&&['127.0.0.1','[::1]'].includes(origin.hostname)))) throw new Error('invalid_origin');
const pieces=[];let length=0;
for await(const chunk of process.stdin){length+=chunk.length;if(length>30000)throw new Error('input_too_large');pieces.push(chunk);}
const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(pieces)).trim();
if(!text)throw new Error('input_required');
const body={route:process.env.CHAT_ROUTE||'mock',disclosureVersion:1,messages:[{role:'user',text}],memory:[]};
const headers={'Content-Type':'application/json'};
if(process.env.CHAT_APP_CHECK_TOKEN)headers['X-Firebase-AppCheck']=process.env.CHAT_APP_CHECK_TOKEN;
if(process.env.CHAT_VOUCHER)headers.Authorization=`Bearer ${process.env.CHAT_VOUCHER}`;
const response=await fetch(new URL('/v1/chat/stream',origin),{method:'POST',headers,body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(65000)});
if(!response.ok||!response.headers.get('content-type')?.startsWith('text/event-stream'))throw new Error(`request_rejected_${response.status}`);
// This reference CLI intentionally displays the server's bounded SSE on stdout.
let received=0;
for await(const chunk of response.body){received+=chunk.length;if(received>100000)throw new Error('response_too_large');if(!process.stdout.write(chunk))await once(process.stdout,'drain');}
