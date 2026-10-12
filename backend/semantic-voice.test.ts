import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { Pool } from 'pg';
import { backendConfig } from './config';
import { createApp } from './app';
import { ObjectStore } from './storage';

test('live semantic gateway waits through hesitation and finishes without a client commit', {
  skip: process.env.MURMUR_LIVE_SEMANTIC_VOICE !== '1', timeout: 150_000,
}, async () => {
  const config = backendConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  const { app } = await createApp({ config, pool, objects: new ObjectStore(config.objectDirectory) });
  let socket: WebSocket | undefined;
  let token = '';
  const headers = () => ({ 'x-murmur-client': 'v2', authorization: `Bearer ${token}` });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const identity = await app.inject({ method: 'POST', url: '/v2/identity', headers: headers(), payload: {} });
    assert.equal(identity.statusCode, 200); token = identity.json().token;
    const ticket = await app.inject({ method: 'POST', url: '/v2/live-voice-ticket', headers: headers(), payload: {} });
    assert.equal(ticket.statusCode, 200);
    const finals: string[] = [];
    const events: string[] = [];
    let failure: Error | undefined;
    socket = new WebSocket(address.replace('http:', 'ws:') + '/v2/live-voice', ['murmur-ticket.' + ticket.json().token, 'murmur-semantic-v1']);
    const ready = new Promise<void>((resolve, reject) => {
      socket!.on('error', (error) => { failure = error; reject(error); });
      socket!.on('message', (raw) => {
        const event = JSON.parse(raw.toString());
        events.push(event.type);
        if (event.type === 'error') { failure = new Error(event.message); reject(failure); }
        if (event.type === 'ready') {
          if (event.turnDetection !== 'semantic') reject(new Error('Semantic turn detection was not negotiated'));
          else resolve();
        }
        if (event.type === 'conversation.item.input_audio_transcription.completed') finals.push(event.transcript);
      });
    });
    await Promise.race([ready, sleep(15000).then(() => { throw new Error('Voice ready timeout'); })]);
    const pcm = async (words: string) => {
      const openai = config.providers.openai;
      const response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST', headers: { Authorization: `Bearer ${openai.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: openai.speechModel, voice: openai.speechVoice, input: words, response_format: 'pcm' }),
        signal: AbortSignal.timeout(45000),
      });
      assert.equal(response.status, 200, 'Speech fixture generation failed');
      return Buffer.from(await response.arrayBuffer());
    };
    const opening = await pcm('Could you play, um...');
    const continuation = await pcm('Lenny’s podcast with Brian Halligan.');
    const stream = async (audio: Buffer) => {
      for (let offset = 0; offset < audio.length; offset += 4800) {
        if (failure) throw failure;
        socket!.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: audio.subarray(offset, offset + 4800).toString('base64') }));
        await sleep(100);
      }
    };
    await stream(opening);
    await stream(Buffer.alloc(48_000 * 1.5));
    assert.equal(finals.length, 0, 'A hesitant unfinished request was committed before its continuation');
    await stream(continuation);
    for (let i = 0; i < 120 && !finals.length; i++) await stream(Buffer.alloc(4800));
    if (failure) throw failure;
    assert.equal(finals.length, 1);
    assert.match(finals[0]!, /Brian Halligan/i);
    assert(events.includes('input_audio_buffer.speech_started'));
    assert(events.includes('input_audio_buffer.speech_stopped'));
    assert(events.includes('input_audio_buffer.committed'));
    console.info('Semantic hesitation transcript:', finals[0]);
    const longer = await pcm('Before you continue with the podcast, could you explain what the guest meant by product market fit and how that relates to the example about building a company that we were listening to just now?');
    assert(longer.length > 48_000 * 8, 'Long-request fixture must exceed the former eight-second cutoff');
    await stream(longer);
    for (let i = 0; i < 120 && finals.length < 2; i++) await stream(Buffer.alloc(4800));
    if (failure) throw failure;
    assert.equal(finals.length, 2, 'A long request must remain a single complete turn');
    assert.match(finals[1]!, /product.market fit/i);
    assert.match(finals[1]!, /just now/i);
    console.info('Semantic long-request transcript:', finals[1]);
  } finally {
    socket?.terminate();
    if (token) await app.inject({ method: 'DELETE', url: '/v2/identity', headers: headers() });
    await app.close(); await pool.end();
  }
});
