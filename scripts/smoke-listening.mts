// Opt-in paid integration check against an already-running local backend.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import assert from 'node:assert/strict';

const root = 'http://127.0.0.1:4545/v2';
let token: string | undefined;
const headers = () => ({ 'Content-Type': 'application/json', 'X-Murmur-Client': 'v2', ...(token ? { Authorization: `Bearer ${token}` } : {}) });
async function post(path: string, body: unknown) {
  const response = await fetch(root + path, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${data.error?.code ?? 'request_failed'}`);
  return data;
}
try {
  token = (await post('/identity', {})).token;
  let session = await post('/sessions', { episodeId: 'small-places' });
  session = await post(`/sessions/${session.id}/observations`, { revision: session.revision, audioVersion: session.audioVersion, positionSeconds: 38, reason: 'interrupt' });
  const ticket = await post(`/sessions/${session.id}/voice-ticket`, {});
  const wav = await readFile(new URL('../backend/fixtures/voice-request.wav', import.meta.url));
  let pcm: Buffer | undefined;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4);
    if (wav.toString('ascii', offset, offset + 4) === 'data') pcm = wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  assert(pcm?.length);
  const voiceStart = performance.now();
  const transcript = await new Promise<string>((resolve, reject) => {
    const socket = new WebSocket('ws://127.0.0.1:4545/v2/voice', [`murmur-ticket.${ticket.clientSecret}`]);
    const timeout = setTimeout(() => { socket.close(); reject(new Error('Transcription timeout')); }, 25_000);
    let completed = false;
    socket.on('open', () => {
      void (async () => {
        for (let offset = 0; offset < pcm!.length && socket.readyState === WebSocket.OPEN; offset += 4800) {
          socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm!.subarray(offset, offset + 4800).toString('base64') }));
          await new Promise((done) => setTimeout(done, 100));
        }
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      })().catch(reject);
    });
    socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'error') { clearTimeout(timeout); socket.close(); reject(new Error(event.error.message)); }
      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        completed = true; clearTimeout(timeout); socket.close(); resolve(event.transcript);
      }
    });
    socket.on('error', (error) => { clearTimeout(timeout); reject(error); });
    socket.on('close', () => { clearTimeout(timeout); if (!completed) reject(new Error('Voice connection ended before transcription')); });
  });
  assert.match(transcript.toLowerCase(), /deeper/);
  console.log(JSON.stringify({ stage: 'transcription', milliseconds: Math.round(performance.now() - voiceStart), transcript }));
  const answerStart = performance.now();
  const answer = await post(`/sessions/${session.id}/turns`, { revision: session.revision, audioVersion: session.audioVersion, positionSeconds: 38, requestId: randomUUID(), utterance: transcript });
  assert.equal(answer.decision, 'jev'); assert(answer.answer.length > 0); assert.equal(answer.session.bookmarkSeconds, 38);
  console.log(JSON.stringify({ stage: 'answer', milliseconds: Math.round(performance.now() - answerStart), evidence: answer.evidence.map((item: { id: string }) => item.id), words: answer.answer.split(/\s+/).length }));
  const speechStart = performance.now();
  const speech = await fetch(root + `/sessions/${session.id}/turns/${answer.requestId}/speech`, { method: 'POST', headers: headers(), body: '{}', signal: AbortSignal.timeout(30_000) });
  assert.equal(speech.status, 200); assert.equal(speech.headers.get('X-Murmur-Voice-Disclosure'), 'ai-generated');
  const audio = await speech.arrayBuffer(); assert(audio.byteLength > 1000);
  console.log(JSON.stringify({ stage: 'speech', milliseconds: Math.round(performance.now() - speechStart), bytes: audio.byteLength }));
  const returned = await post(`/sessions/${session.id}/turns`, { revision: answer.session.revision, audioVersion: session.audioVersion, positionSeconds: 38, requestId: randomUUID(), utterance: 'back to the podcast' });
  assert.equal(returned.action.kind, 'return'); assert.equal(returned.action.positionSeconds, 38);
  await post(`/sessions/${session.id}/acknowledgements`, { revision: returned.session.revision, audioVersion: session.audioVersion, positionSeconds: 38, actionId: returned.action.id });
  console.log('Live transcription, Jev, answer, speech, and exact return passed. Synthetic input does not replace physical microphone testing.');
} finally {
  if (token) await fetch(root + '/identity', { method: 'DELETE', headers: headers() });
}
