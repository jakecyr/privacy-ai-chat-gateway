import {readFile,writeFile} from 'node:fs/promises';
import {COMMERCIAL_POLICY,validateCommercialMargin} from './commercial-policy.js';
import {catalogRouteID,routeSpecification} from './route-specs.js';
const [catalogPath,pricesPath,output]=process.argv.slice(2);
if(!output)throw new Error('Usage: node gateway/render-model-routes.mjs CATALOG PRICES OUTPUT');
const catalog=JSON.parse(await readFile(catalogPath)),prices=JSON.parse(await readFile(pricesPath));
const routes=[],routeCosts={};
for(const model of catalog.models)for(const reasoning of model.reasoning) {
 const price=prices[model.provider];if(!price)throw new Error('pricing_missing');
 const sizes={none:1200,low:2400,medium:3600,high:4800,xhigh:6400,max:8192};
 const route={id:catalogRouteID(model.provider,model.model,reasoning),provider:model.provider,model:model.model,label:model.label,profile:'text-zdr-v1',reasoning,inputTokens:32768,outputTokens:sizes[reasoning],inputMicroUSDPerToken:price.inputMicroUSDPerToken,outputMicroUSDPerToken:price.outputMicroUSDPerToken,enabled:false,disclosureVersion:1,retentionProfile:'zdr',verifiedUntil:0,targetDigest:'',verification:{agreementApproved:false,payloadVerified:false,cacheDisabled:false,loggingDisabled:false,abuseMonitoringApproved:false,persistentUserIDNotRequired:false,pricingVerified:false,evidenceDigest:'',reviewedAt:0}};
 const spec=routeSpecification(route.id,route);if(!spec)throw new Error('invalid_model_profile');
 routeCosts[route.id]=Math.ceil(spec.minimumReservationMicroUSD/5000)*5000;routes.push(route);
}
await writeFile(output,JSON.stringify({enabled:false,version:catalog.version,routes,issuerPolicy:{monthlyUnits:COMMERCIAL_POLICY.monthlyUnits,commercialPolicy:COMMERCIAL_POLICY,routeCosts,modelRoutes:routes,trial:COMMERCIAL_POLICY.trial}},null,2)+'\n');
console.log(JSON.stringify({routes:routes.length,enabled:false,monthlyModelBudgetUSD:1,freeCampaignBudgetUSD:200}));
