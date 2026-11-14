import { GatewayError } from './admission.js';
import { readBytes } from './http-boundaries.js';

export const DICTATION_ROUTE = Object.freeze({ id: 'openai-whisper-dictation' });
// Microdollars reserved against the subscriber's existing monthly allowance.
export const DICTATION_UNITS = 6000;
export const MAX_WAV_BYTES = 44 + 60 * 16_000 * 2;

export async function readDictation(request, signal) {
  if (request.headers['content-type'] !== 'audio/wav' || request.headers['content-encoding']) {
    throw new GatewayError(415, 'invalid_request');
  }
  const wav = await readBytes(request, { limit: MAX_WAV_BYTES, signal });
  if (wav.length < 44 + 8_000 || wav.length % 2 ||
      wav.toString('ascii', 0, 4) !== 'RIFF' || wav.readUInt32LE(4) !== wav.length - 8 ||
      wav.toString('ascii', 8, 16) !== 'WAVEfmt ' || wav.readUInt32LE(16) !== 16 ||
      wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(22) !== 1 || wav.readUInt32LE(24) !== 16_000 ||
      wav.readUInt32LE(28) !== 32_000 || wav.readUInt16LE(32) !== 2 || wav.readUInt16LE(34) !== 16 ||
      wav.toString('ascii', 36, 40) !== 'data' || wav.readUInt32LE(40) !== wav.length - 44) {
    throw new GatewayError(400, 'invalid_request');
  }
  return wav;
}

export function openAIDictation({ apiKey, fetcher = fetch }) {
  return async (wav, signal) => {
    const form = new FormData();
    form.set('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
    form.set('model', 'whisper-1');
    form.set('response_format', 'json');
    const response = await fetcher('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + apiKey },
      body: form, signal, redirect: 'error'
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new GatewayError(503, 'upstream_failure');
    }
    let body, bytes;
    try {
      bytes = await readBytes(response.body, { limit: 32_768, signal });
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch { throw new GatewayError(503, 'upstream_failure'); }
    if (typeof body?.text !== 'string' || Buffer.byteLength(body.text) > 16_384) {
      throw new GatewayError(503, 'upstream_failure');
    }
    return body.text;
  };
}
