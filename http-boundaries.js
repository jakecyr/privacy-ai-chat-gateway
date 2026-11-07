import {GatewayError} from './admission.js';

// Racing a dependency also closes the HTTP lifetime when the dependency ignores
// AbortSignal. The dependency's late result cannot resume the admission chain.
export async function abortable(operation,signal) {
  const failure=()=>new GatewayError(503,'upstream_timeout');
  if(signal.aborted) throw failure();
  let onAbort;
  const cancelled=new Promise((_,reject)=>{
    onAbort=()=>reject(failure());
    signal.addEventListener('abort',onAbort,{once:true});
  });
  try {
    return await Promise.race([Promise.resolve().then(()=>{
      if(signal.aborted) throw failure();
      return operation();
    }),cancelled]);
  } finally { signal.removeEventListener('abort',onAbort); }
}

export async function readJSON(request,{limit,signal}) {
  let length=0;const chunks=[],iterator=request[Symbol.asyncIterator]();
  while(true) {
    const {done,value}=await abortable(()=>iterator.next(),signal);
    if(done)break;
    length+=value.length;
    if(length>limit)throw new GatewayError(413,'invalid_request');
    chunks.push(value);
  }
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}
  catch{throw new GatewayError(400,'invalid_request');}
}

// Worst-case JSON escaping is six bytes per input byte. This keeps each SSE
// data line below the iOS decoder's 16 KiB limit, even for control characters.
export function* textChunks(text,maxBytes=2048) {
  let chunk='',bytes=0;
  for(const scalar of text) {
    const size=Buffer.byteLength(scalar);
    if(bytes+size>maxBytes){yield chunk;chunk='';bytes=0;}
    chunk+=scalar;bytes+=size;
  }
  if(chunk)yield chunk;
}
