// Local development mock only. Do not deploy this server or send real user data.
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 32768;
export function validate(value) {
  const keys = (o, allowed) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => allowed.includes(k));
  if (!keys(value, ['route', 'disclosureVersion', 'messages', 'memory']) || value.route !== 'mock' || value.disclosureVersion !== 1) return false;
  if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 24 || value.messages.at(-1)?.role !== 'user') return false;
  if (!value.messages.every(m => keys(m, ['role', 'text']) && ['user', 'assistant'].includes(m.role) && typeof m.text === 'string' && m.text.trim().length > 0)) return false;
  return Array.isArray(value.memory) && value.memory.length <= 3 && value.memory.every(m => typeof m === 'string') && Buffer.byteLength(value.memory.join(''), 'utf8') <= 750;
}
export function createServer() {
 return http.createServer(async (req, res) => {
  const fail = status => { res.writeHead(status, {'Content-Type':'application/json','Cache-Control':'no-store'}); res.end('{"error":"invalid_request"}'); };
  if (req.method === 'GET' && req.url === '/v1/models') { res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'}); return res.end(JSON.stringify({version:1, routes:[{id:'mock', provider:'Mock', disclosureVersion:1}]})); }
  if (req.method !== 'POST' || req.url !== '/v1/chat/stream') return fail(404);
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '') || req.headers['content-encoding']) return fail(415);
  let chunks = [], size = 0, tooLarge = false;
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BYTES) { tooLarge = true; chunks = []; } else if (!tooLarge) chunks.push(chunk); }
  if (tooLarge) return fail(413);
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))); } catch { return fail(400); }
  if (!validate(data)) return fail(400);
  res.writeHead(200, {'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});
  const event = (name, body) => res.write(`event: ${name}\ndata: ${JSON.stringify(body)}\n\n`);
  event('meta',{route:'mock',disclosureVersion:1}); event('delta',{text:'This is a local mock response. No model was called.'}); event('done',{reason:'stop'}); res.end();
 });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) createServer().listen(8787,'127.0.0.1');
