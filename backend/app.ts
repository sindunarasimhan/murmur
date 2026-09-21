import Fastify, { type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import type { Pool } from 'pg';
import { acknowledgementSchema, observationSchema, turnRequestSchema } from '../shared/listening';
import { synthesizeAudio } from '../src/server/openai-audio/provider';
import { UpstreamError } from '../src/server/http/upstream';
import type { BackendConfig } from './config';
import { Repository } from './repository';
import { ListeningService } from './listening-service';
import { createIntelligence, type Intelligence } from './intelligence';
import { ObjectStore } from './storage';
import { ServiceError } from './errors';
import { transaction } from './database';
import { VoiceGateway } from './voice-gateway';
import { ContinuousVoiceGateway } from './continuous-voice';
import { CatalogService } from './catalog-service';
import { createCatalogInterpreter, type CatalogInterpreter } from './catalog-interpreter';

function bearer(request: FastifyRequest) {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7);
  return request.headers.cookie?.split(';').map((value) => value.trim()).find((value) => value.startsWith('murmur_identity='))?.slice('murmur_identity='.length);
}
const sessionId = (request: FastifyRequest) => z.uuid().parse((request.params as { id: string }).id);
export async function createApp(options: { config: BackendConfig; pool: Pool; objects: ObjectStore; intelligence?: Intelligence; catalogInterpreter?: CatalogInterpreter; speech?: typeof synthesizeAudio }) {
  const { config, pool, objects } = options;
  const repository = new Repository(pool, config);
  const listening = new ListeningService(repository, options.intelligence ?? createIntelligence(config));
  const voice = new VoiceGateway(repository, config);
  const continuousVoice = new ContinuousVoiceGateway(repository, config);
  const catalog = new CatalogService(repository, options.catalogInterpreter ?? createCatalogInterpreter(config.providers.typesafe));
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024, requestTimeout: 30_000 });
  await app.register(websocket, { options: { maxPayload: 128 * 1024 } });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method) && request.headers['x-murmur-client'] !== 'v2') {
      throw new ServiceError(403, 'client_required', 'Open this request through Murmur.');
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'invalid_request', message: 'That request was incomplete or invalid.' } });
    if (error instanceof ServiceError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    if (error instanceof UpstreamError) return reply.code(503).send({ error: { code: `provider_${error.kind}`, message: 'Murmur could not reach its voice or answer service. Your place is saved.' } });
    const status = typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : 500;
    return reply.code(status >= 400 && status < 500 ? status : 500).send({ error: { code: 'request_failed', message: 'Murmur could not finish that request. Please try again.' } });
  });
  const owner = async (request: FastifyRequest) => {
    const id = await repository.identity(bearer(request));
    if (!id) throw new ServiceError(401, 'identity_required', 'Your listening session has expired. Reopen the player to continue.');
    return id;
  };
  app.get('/health', async () => { await pool.query('SELECT 1'); return { status: 'ok' }; });
  app.post('/v2/identity', async (request, reply) => {
    const existing = await repository.identity(bearer(request));
    if (existing) return { id: existing };
    const identity = await repository.createIdentity(request.ip);
    reply.header('Set-Cookie', `murmur_identity=${identity.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${config.secureCookies ? '; Secure' : ''}`);
    return identity;
  });
  app.delete('/v2/identity', async (request, reply) => {
    const id = await owner(request);
    continuousVoice.cancel(id);
    const sessions = await pool.query('SELECT id FROM listening_sessions WHERE owner_id=$1', [id]);
    for (const session of sessions.rows) { listening.cancel(session.id); voice.cancel(session.id); }
    await repository.deleteIdentity(id);
    reply.header('Set-Cookie', 'murmur_identity=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return { deleted: true };
  });
  app.get('/v2/episode', () => repository.episode());
  app.get('/v2/catalog', () => repository.catalog());
  app.get('/v2/catalog/:episodeId', (request) => repository.episode(z.string().regex(/^lenny-[a-z0-9_-]+$/).parse((request.params as { episodeId: string }).episodeId)));
  app.post('/v2/catalog/resolve', async (request, reply) => {
    const input = z.object({ utterance: z.string().trim().min(1).max(1000), currentEpisodeId: z.string().optional(), history: z.array(z.string().max(2000)).max(4).default([]) }).strict().parse(request.body);
    const controller = new AbortController();
    const disconnect = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', disconnect);
    try { return await catalog.resolve(await owner(request), input.utterance, input.currentEpisodeId, input.history, controller.signal); }
    finally { reply.raw.off('close', disconnect); }
  });
  app.post('/v2/live-voice-ticket', async (request) => continuousVoice.ticket(await owner(request)));
  app.delete('/v2/live-voice', async (request) => { continuousVoice.cancel(await owner(request)); return { stopped: true }; });
  app.post('/v2/sessions', async (request) => {
    const input = z.object({ episodeId: z.string().regex(/^(small-places|lenny-[a-z0-9_-]+)$/) }).strict().parse(request.body);
    if (config.focusEpisodeId && input.episodeId !== config.focusEpisodeId) throw new ServiceError(409, 'focus_episode', 'That episode is not available in the current catalog.');
    return repository.openSession(await owner(request), input.episodeId);
  });
  app.get('/v2/sessions/:id', async (request) => repository.session(await owner(request), sessionId(request)));
  app.post('/v2/sessions/:id/observations', async (request) => {
    const input = observationSchema.parse(request.body);
    const result = await repository.observe(await owner(request), sessionId(request), input);
    listening.cancel(result.id); voice.cancel(result.id);
    return result;
  });
  app.post('/v2/sessions/:id/turns', async (request, reply) => {
    const input = turnRequestSchema.parse(request.body);
    const controller = new AbortController();
    const disconnect = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', disconnect);
    try { return await listening.turn(await owner(request), sessionId(request), input, controller.signal); }
    finally { reply.raw.off('close', disconnect); }
  });
  app.post('/v2/sessions/:id/acknowledgements', async (request) => repository.acknowledge(await owner(request), sessionId(request), acknowledgementSchema.parse(request.body)));
  app.post('/v2/sessions/:id/voice-ticket', async (request) => {
    if (!config.providers.openai.apiKey) throw new ServiceError(503, 'voice_unconfigured', 'Voice transcription is not configured yet.');
    const token = await repository.voiceTicket(await owner(request), sessionId(request));
    return { clientSecret: token, expiresAt: Math.floor(Date.now() / 1000) + 30, model: config.providers.openai.realtimeModel, sampleRate: 24_000 };
  });
  app.post('/v2/sessions/:id/turns/:turnId/speech', async (request, reply) => {
    const id = sessionId(request);
    const turnId = z.uuid().parse((request.params as { turnId: string }).turnId);
    const ownerId = await owner(request);
    const speech = await transaction(pool, async (client) => {
      await repository.session(ownerId, id, client, true);
      const turn = await client.query(`SELECT result,speech_status,speech_audio FROM conversation_turns WHERE session_id=$1 AND request_id=$2 AND status='complete' FOR UPDATE`, [id, turnId]);
      const row = turn.rows[0];
      if (!row?.result?.answer) throw new ServiceError(404, 'answer_missing', 'There is no spoken answer for that request.');
      if (row.speech_audio) return { audio: row.speech_audio as Buffer };
      if (row.speech_status !== 'none') throw new ServiceError(409, 'speech_already_requested', 'That spoken answer was already requested.');
      if (!config.providers.openai.apiKey) throw new ServiceError(503, 'speech_unconfigured', 'Spoken audio is unavailable. The answer is still on screen.');
      await repository.charge(ownerId, client);
      await client.query(`UPDATE conversation_turns SET speech_status='processing' WHERE session_id=$1 AND request_id=$2`, [id, turnId]);
      return { text: row.result.answer as string };
    });
    let bytes: Buffer;
    if (speech.audio) bytes = speech.audio;
    else {
      const controller = new AbortController();
      const disconnect = () => { if (!reply.raw.writableEnded) controller.abort(); };
      reply.raw.on('close', disconnect);
      try {
        bytes = Buffer.from(await (options.speech ?? synthesizeAudio)(speech.text!, { config: { ...config.providers.openai, apiKey: config.providers.openai.apiKey! }, signal: controller.signal }));
        await pool.query(`UPDATE conversation_turns SET speech_status='complete',speech_audio=$3 WHERE session_id=$1 AND request_id=$2`, [id, turnId, bytes]);
      } catch (error) {
        await pool.query(`UPDATE conversation_turns SET speech_status='failed' WHERE session_id=$1 AND request_id=$2`, [id, turnId]);
        throw error;
      } finally { reply.raw.off('close', disconnect); }
    }
    return reply.type('audio/mpeg').header('X-Murmur-Voice-Disclosure', 'ai-generated').send(bytes);
  });
  // Only episode audio is exposed here. Answers and transcripts require identity.
  app.get('/v2/media/:key', async (request, reply) => {
    const key = z.string().regex(/^[a-f0-9]{64}\.(?:wav|mp3)$/).parse((request.params as { key: string }).key);
    const match = await pool.query(`SELECT 1 FROM episodes WHERE audio_key=$1 AND status='ready'`, [key]);
    if (!match.rowCount) throw new ServiceError(404, 'audio_missing', 'This audio is unavailable.');
    const { size } = await objects.stat(key);
    reply.type(key.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav').header('Accept-Ranges', 'bytes').header('ETag', `"${key}"`);
    const range = request.headers.range;
    if (range) {
      const parts = range.match(/^bytes=(\d*)-(\d*)$/);
      const start = parts?.[1] ? Number(parts[1]) : parts?.[2] ? Math.max(0, size - Number(parts[2])) : NaN;
      const end = parts?.[1] && parts[2] ? Math.min(size - 1, Number(parts[2])) : size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`).header('Content-Length', end - start + 1).send(createReadStream(objects.path(key), { start, end }));
    }
    return reply.header('Content-Length', size).send(createReadStream(objects.path(key)));
  });
  voice.register(app);
  continuousVoice.register(app);
  app.addHook('onClose', async () => { listening.close(); voice.close(); continuousVoice.close(); });
  return { app, repository, listening };
}
