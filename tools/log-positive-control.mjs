import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

// Writes one synthetic global-resource entry in an isolated staging project.
// The chat-service exclusion intentionally does not match this positive control.
const [project,inventoryPath,reportPath]=process.argv.slice(2);
if(!project||!inventoryPath||!reportPath)throw new Error('usage: PROJECT INVENTORY_JSON PRIVATE_REPORT_JSON');
const inventory=JSON.parse(await readFile(inventoryPath));
const sink=inventory.sinks.find(item=>item.scopeType==='project'&&item.scopeID===project&&item.name==='_Default');
const match=/^logging\.googleapis\.com\/(projects\/[^/]+\/locations\/[^/]+\/buckets\/[^/]+)$/.exec(sink?.destination||'');
if(!match)throw new Error('known_default_bucket_required');
const view=match[1]+'/views/_AllLogs';
const marker='SYNTHETIC_PRIVATE_CHAT_POSITIVE_CONTROL_'+randomUUID();
const token=execFileSync('gcloud',['auth','print-access-token'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const startedAt=new Date().toISOString();
const logName=`projects/${project}/logs/privacy-chat-positive-control`;
const report={startedAt,testedView:view,markerHash:createHash('sha256').update(marker).digest('hex'),detected:false,fullLoggingReleaseGatePassed:false};
async function call(path,body) {
  const response=await fetch('https://logging.googleapis.com/v2/'+path,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','x-goog-user-project':project},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error(`logging_api_${response.status}`);
  return response.json();
}
try {
  await call('entries:write',{entries:[{logName,resource:{type:'global',labels:{project_id:project}},timestamp:startedAt,severity:'NOTICE',textPayload:marker}]});
  const deadline=Date.now()+45000;
  while(Date.now()<deadline) {
    const result=await call('entries:list',{resourceNames:[view],filter:`logName="${logName}" AND textPayload="${marker}"`,pageSize:10});
    if(result.entries?.some(entry=>entry.textPayload===marker)){report.detected=true;break;}
    await delay(3000);
  }
}catch(error){report.error=/^logging_api_\d+$/.test(error.message)?error.message:'positive_control_unavailable';}
report.completedAt=new Date().toISOString();
await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({positiveControlDetected:report.detected,error:report.error,fullLoggingReleaseGatePassed:false}));
process.exitCode=report.detected?0:1;
