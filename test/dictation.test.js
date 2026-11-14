import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { GatewayError } from '../admission.js';
import { DICTATION_ROUTE, MAX_WAV_BYTES, openAIDictation } from '../dictation.js';
import { createProductionServer } from '../production-server.js';

function wav() {
  const data = Buffer.alloc(8044);
  data.write('RIFF');
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16_000, 24);
  data.writeUInt32LE(32_000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(data.length - 44, 40);
  return data;
}

test('dictation accepts one attested, paid, route-bound WAV and sends it to Whisper', async t => {
  let calls = 0;
  let enabled = true;
  const spent = new Set();
  const dictate = openAIDictation({
    apiKey: 'synthetic-key',
    fetcher: async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
      assert.equal(options.redirect, 'error');
      assert.equal(options.body.get('model'), 'whisper-1');
      assert.deepEqual(Buffer.from(await options.body.get('file').arrayBuffer()), wav());
      return Response.json({ text: 'Synthetic transcript' });
    }
  });
  const server = createProductionServer({
    appCheck: { verifyToken: async token => ({ appId: token === 'valid' ? 'release' : 'untrusted' }) },
    allowedAppIDs: ['release'],
    configuration: () => ({ enabled: true, dictationEnabled: enabled }),
    quota: { take: () => {} },
    generate: () => assert.fail('Should never generate a chat'),
    validateVoucher: (token, route) => {
      assert.equal(route.id, DICTATION_ROUTE.id);
      if (token !== 'paid-dictation-voucher') throw new GatewayError(401, 'access_required');
    },
    spendVoucher: token => {
      if (spent.has(token)) throw new GatewayError(401, 'access_required');
      spent.add(token);
    },
    dictate
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const post = (body, auth = 'paid-dictation-voucher', attestation = 'valid') =>
    fetch('http://127.0.0.1:' + server.address().port + '/v1/dictation', {
      method: 'POST',
      headers: { 'X-Firebase-AppCheck': attestation, 'Content-Type': 'audio/wav', Authorization: 'Bearer ' + auth },
      body
    });
  assert.equal((await post(wav(), 'trial-chat-voucher')).status, 401);
  assert.equal((await post(wav(), 'paid-dictation-voucher', 'untrusted')).status, 401);
  // An oversized upload is rejected from its headers. Wait for that response
  // before sending any body, so the test does not race the socket closing.
  const oversizedStatus = await new Promise((resolve, reject) => {
    const upload = request('http://127.0.0.1:' + server.address().port + '/v1/dictation', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav', 'Content-Length': MAX_WAV_BYTES + 1 }
    }, response => {
      response.resume();
      response.once('end', () => { resolve(response.statusCode); upload.destroy(); });
    });
    upload.once('error', reject);
    upload.setTimeout(2000, () => upload.destroy(new Error('No oversized upload response')));
    upload.flushHeaders();
  });
  assert.equal(oversizedStatus, 413);
  const invalid = wav();
  invalid.writeUInt16LE(2, 22);
  assert.equal((await post(invalid)).status, 400);
  enabled = false;
  assert.equal((await post(wav())).status, 503);
  assert.equal(spent.size, 0);
  enabled = true;
  const reply = await post(wav());
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await reply.json(), { text: 'Synthetic transcript' });
  assert.equal((await post(wav())).status, 401);
  assert.equal(calls, 1);
});
