import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const [project,file]=process.argv.slice(2);
if(!project || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) || !file)throw new Error('Usage: node tools/update-model-catalog.mjs PROJECT FILE');
const bytes=await readFile(file);if(bytes.length>16384)throw new Error('catalog_too_large');
const catalog=JSON.parse(bytes);
const levels={OpenAI:['none','low','medium','high','xhigh','max'],Claude:['low','medium','high','xhigh','max'],Gemini:['low','medium','high']};
const prefixes={OpenAI:'gpt-',Claude:'claude-',Gemini:'gemini-'};
if(Object.keys(catalog).sort().join(',')!=='models,version'||!Number.isSafeInteger(catalog.version)||catalog.version<1||catalog.version>1_000_000_000||!Array.isArray(catalog.models)||catalog.models.length>32)throw new Error('invalid_catalog');
const ids=new Set(),models=new Set();
let routeCount=0;
for(const entry of catalog.models) {
 if(Object.keys(entry).sort().join(',')!=='defaultReasoning,id,label,model,provider,reasoning'||!levels[entry.provider]||ids.has(entry.id)||models.has(entry.provider+"/"+entry.model)||!/^([a-z][a-z0-9-]{0,39})$/.test(entry.id)||typeof entry.label!=='string'||!entry.label.length||entry.label.length>60||!(/^[a-z][a-z0-9.-]{0,119}$/).test(entry.model)||!entry.model.startsWith(prefixes[entry.provider])||!Array.isArray(entry.reasoning)||!entry.reasoning.length||new Set(entry.reasoning).size!==entry.reasoning.length||!entry.reasoning.every(x=>levels[entry.provider].includes(x))||!entry.reasoning.includes(entry.defaultReasoning))throw new Error('invalid_catalog_model');
 ids.add(entry.id);models.add(entry.provider+"/"+entry.model);
 routeCount+=entry.reasoning.length;
}
if(routeCount>32)throw new Error('too_many_catalog_routes');
const token=execFileSync('gcloud',['auth','print-access-token'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const url=`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/public/modelCatalog`;
const result=await fetch(url+'?updateMask.fieldPaths=payload',{method:'PATCH',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','x-goog-user-project':project},body:JSON.stringify({fields:{payload:{stringValue:JSON.stringify(catalog)}}})});
if(!result.ok)throw new Error('catalog_update_failed_'+result.status);
const read=await fetch(url);if(!read.ok)throw new Error('public_catalog_read_failed_'+read.status);
const actual=JSON.parse((await read.json()).fields.payload.stringValue);if(JSON.stringify(actual)!==JSON.stringify(catalog))throw new Error('catalog_readback_mismatch');
console.log(JSON.stringify({project,version:catalog.version,models:catalog.models.map(x=>x.label),publicReadVerified:true}));
