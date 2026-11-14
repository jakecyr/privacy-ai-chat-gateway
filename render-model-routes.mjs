import {readFile,writeFile} from 'node:fs/promises';
import {COMMERCIAL_POLICY,LAUNCH_PLANS,validateSubscriptionTerms} from './commercial-policy.js';
import {catalogRouteID,OPENAI_STANDARD_PROFILE,routeSpecification} from './route-specs.js';
const [catalogPath,pricesPath,output,mode]=process.argv.slice(2);
if(!output || (mode && mode!=='--standard-openai'))throw new Error('Usage: node gateway/render-model-routes.mjs CATALOG PRICES OUTPUT [--standard-openai]');
const standard=mode==='--standard-openai';
const catalog=JSON.parse(await readFile(catalogPath)),prices=JSON.parse(await readFile(pricesPath));
const routes=[],routeCosts={};
const models=standard?catalog.models.filter(model=>model.provider==='OpenAI'):catalog.models;
if(!models.length)throw new Error('model_profile_missing');
for(const model of models)for(const reasoning of model.reasoning) {
 const price=prices[model.model]??prices[model.provider];if(!price)throw new Error('pricing_missing');
 const sizes={none:1200,low:2400,medium:3600,high:4800,xhigh:6400,max:8192};
 const route={id:(standard?'standard-':'')+catalogRouteID(model.provider,model.model,reasoning),provider:model.provider,model:model.model,label:model.label,profile:standard?OPENAI_STANDARD_PROFILE:'text-zdr-v1',reasoning,inputTokens:32768,outputTokens:sizes[reasoning],inputMicroUSDPerToken:price.inputMicroUSDPerToken,outputMicroUSDPerToken:price.outputMicroUSDPerToken,enabled:false,disclosureVersion:standard?3:1,retentionProfile:standard?'standard':'zdr',verifiedUntil:0,targetDigest:'',verification:{agreementApproved:false,payloadVerified:false,cacheDisabled:false,loggingDisabled:false,...(standard?{standardRetentionDisclosed:false}:{abuseMonitoringApproved:false}),persistentUserIDNotRequired:false,pricingVerified:false,evidenceDigest:'',reviewedAt:0}};
 const spec=routeSpecification(route.id,route);if(!spec)throw new Error('invalid_model_profile');
 routeCosts[route.id]=Math.ceil(spec.minimumReservationMicroUSD/5000)*5000;routes.push(route);
}
const monthlyUnitsByProduct=Object.fromEntries(Object.entries(LAUNCH_PLANS).map(([id,plan])=>[id,plan.monthlyUnits]));
const issuerPolicy={productIDs:Object.keys(monthlyUnitsByProduct),monthlyUnits:Math.max(...Object.values(monthlyUnitsByProduct)),
 monthlyUnitsByProduct,routeCosts,modelRoutes:routes,trial:COMMERCIAL_POLICY.trial};
validateSubscriptionTerms(issuerPolicy);
await writeFile(output,JSON.stringify({enabled:false,version:catalog.version,routes,issuerPolicy},null,2)+'\n');
console.log(JSON.stringify({routes:routes.length,enabled:false,monthlyModelBudgetUSD:[1,2,4],freeCampaignBudgetUSD:200}));
