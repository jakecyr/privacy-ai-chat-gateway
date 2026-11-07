import {routeSpecification,verifiedRouteEvidence} from './route-specs.js';
export class GatewayError extends Error {
  constructor(status, code, retryAfter) { super(code); this.status = status; this.code = code; this.retryAfter = retryAfter; }
}
export function validateRequest(value) {
  const keys = (o, allowed) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => allowed.includes(k));
  if (!keys(value,['route','disclosureVersion','messages','memory']) || typeof value.route !== 'string' || !/^[a-z0-9-]{1,80}$/.test(value.route) || !Number.isSafeInteger(value.disclosureVersion) || value.disclosureVersion<1) throw new GatewayError(400,'invalid_request');
  if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 24 || value.messages.at(-1)?.role !== 'user') throw new GatewayError(400,'invalid_request');
  if (!value.messages.every(m => keys(m,['role','text']) && ['user','assistant'].includes(m.role) && typeof m.text === 'string' && m.text.trim().length > 0)) throw new GatewayError(400,'invalid_request');
  if (!Array.isArray(value.memory) || value.memory.length > 3 || !value.memory.every(m => typeof m === 'string') || Buffer.byteLength(value.memory.join('')) > 750) throw new GatewayError(400,'invalid_request');
  return value;
}
export function activeRoute(configuration, id, now = Date.now()) {
  if (!configuration || configuration.enabled !== true || !Number.isFinite(configuration.fetchedAt) || now - configuration.fetchedAt > 15000 || configuration.fetchedAt > now) throw new GatewayError(503,'route_unavailable',15);
  const route = configuration.routes?.find(r => r.id === id);
  const spec=routeSpecification(id);
  if (!spec || !route || route.enabled!==true || !/^[a-z0-9-]{1,80}$/.test(route.id) || !Number.isSafeInteger(route.disclosureVersion) || route.disclosureVersion<1 || route.provider !== spec.provider || route.model !== spec.model || route.disclosureVersion!==1 || !verifiedRouteEvidence(route,now) || route.retentionProfile !== 'zdr' || !Number.isFinite(route.verifiedUntil) || route.verifiedUntil <= now) throw new GatewayError(503,'route_unavailable',15);
  return Object.freeze({...route});
}

export function publicModels(configuration,now=Date.now()) {
  if(!configuration || !Number.isSafeInteger(configuration.version) || configuration.version<1 || !Number.isFinite(configuration.fetchedAt) || now-configuration.fetchedAt>15000 || configuration.fetchedAt>now) throw new GatewayError(503,'route_unavailable',15);
  const routes=[];
  for(const candidate of configuration.routes??[]) {
    try {
      const route=activeRoute(configuration,candidate.id,now);
      routes.push({id:route.id,provider:route.provider,model:route.model,disclosureVersion:route.disclosureVersion});
    } catch(error) { if(!(error instanceof GatewayError)) throw error; }
  }
  return {version:configuration.version,routes};
}

// Share one refresh across concurrent requests. Never extend freshness on a failed read.
export function cachedConfiguration(load,{now=()=>Date.now()}={}) {
  let value, pending;
  return async()=>{
    const timestamp=now();
    if(value && timestamp>=value.fetchedAt && timestamp-value.fetchedAt<15000) return value;
    if(pending) return pending;
    pending=(async()=>{
      try {
        const configuration=await load();
        value=JSON.parse(JSON.stringify({...configuration,fetchedAt:timestamp}));
        return value;
      } catch { value=undefined; throw new GatewayError(503,'route_unavailable',15); }
      finally { pending=undefined; }
    })();
    return pending;
  };
}
export async function verifyAttestation(appCheck, token, allowedAppIDs) {
  if (typeof token !== 'string' || token.length > 8192) throw new GatewayError(401,'attestation_required');
  let claims;
  try { claims = await appCheck.verifyToken(token,{consume:true}); } catch { throw new GatewayError(401,'attestation_invalid'); }
  if (claims.alreadyConsumed || !allowedAppIDs.includes(claims.appId)) throw new GatewayError(401,'attestation_invalid');
}

// Transactions reserve fleet-wide credits; a lost response wastes credits, never replenishes them.
export class DailyQuota {
  #queue = Promise.resolve(); #day = ''; #remaining = 0;
  constructor({reserve, dailyLimit = 1000, batch = 8, now = () => new Date()}) {
    this.reserve = reserve; this.limit = dailyLimit; this.batch = batch; this.now = now;
  }
  take() {
    const work = this.#queue.then(async () => {
      const day = this.now().toISOString().slice(0,10);
      if (this.#day && day < this.#day) throw new GatewayError(503,'clock_invalid');
      if (day !== this.#day) { this.#day = day; this.#remaining = 0; }
      if (this.#remaining === 0) {
        const count = await this.reserve(day,this.batch,this.limit);
        if (!Number.isInteger(count) || count < 0 || count > this.batch) throw new GatewayError(503,'quota_unavailable');
        this.#remaining = count;
      }
      if (!this.#remaining) throw new GatewayError(429,'capacity_exhausted',60);
      this.#remaining--;
    });
    this.#queue = work.catch(() => {}); return work;
  }
}
export function firestoreReservation(database) {
  return (day,batch,limit) => database.runTransaction(async tx => {
    const reference = database.collection('generationQuotas').doc(day);
    const snapshot = await tx.get(reference);
    const used = snapshot.exists ? snapshot.data().reserved : 0;
    if (!Number.isSafeInteger(used) || used < 0) throw new GatewayError(503,'quota_unavailable');
    const count = Math.max(0,Math.min(batch,limit-used));
    if (count) tx.set(reference,{reserved:used+count});
    return count;
  });
}
