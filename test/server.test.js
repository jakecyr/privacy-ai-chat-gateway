import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, validate } from '../server.js';
const valid = {route:'mock', disclosureVersion:1, messages:[{role:'user',text:'hello'}], memory:[]};
test('strict input rejects unknown fields and invalid roles', () => {
 assert.equal(validate(valid), true);
 assert.equal(validate({...valid, model:'external'}), false);
 assert.equal(validate({...valid, messages:[{role:'system',text:'x'}]}), false);
 assert.equal(validate({...valid, memory:['x'.repeat(751)]}), false);
});
test('mock streams one terminal event and rejects invalid media and oversized content', async t => {
 const server = createServer(); await new Promise(r => server.listen(0,'127.0.0.1',r)); t.after(() => server.close());
 const url = `http://127.0.0.1:${server.address().port}/v1/chat/stream`;
 const post = (body, type='application/json') => fetch(url,{method:'POST',headers:{'Content-Type':type},body});
 let response = await post(JSON.stringify(valid)); assert.equal(response.status,200); const body = await response.text(); assert.match(body,/event: meta/); assert.equal((body.match(/event: done/g)||[]).length,1);
 response = await post('{}','text/plain'); assert.equal(response.status,415);
 response = await post('x'.repeat(32769)); assert.equal(response.status,413);
 response = await post('{'); assert.equal(response.status,400);
});
