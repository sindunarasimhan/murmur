import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from './app';
import { backendConfig } from './config';
import { createDatabase, migrate } from './database';
import { ObjectStore } from './storage';
import { enqueuePreparedEpisode, prepareEpisode, PREPARE_QUEUE, startQueue } from './preparation';
import { exactCommand, type Intelligence } from './intelligence';
import { Repository } from './repository';
import { VoiceInputBudget, MAX_VOICE_BYTES } from './voice-budget';
import { ContinuousVoiceGateway } from './continuous-voice';
import type { ListeningSession, TurnRequest } from '../shared/listening';

test('voice input has a bounded, single-utterance protocol', () => {
  const input = new VoiceInputBudget();
  assert.throws(() => input.accept({ type: 'session.update', session: { model: 'other' } }));
  assert.throws(() => input.accept({ type: 'input_audio_buffer.commit' }));
  input.accept({ type: 'input_audio_buffer.append', audio: Buffer.alloc(4800).toString('base64') });
  assert.equal(input.accept({ type: 'input_audio_buffer.commit', ignored: 'not forwarded' }), '{"type":"input_audio_buffer.commit"}');
  assert.throws(() => input.accept({ type: 'input_audio_buffer.commit' }));
  assert.throws(() => input.accept({ type: 'input_audio_buffer.append', audio: 'AAAA' }));
  const over = new VoiceInputBudget();
  assert.throws(() => over.accept({ type: 'input_audio_buffer.append', audio: Buffer.alloc(MAX_VOICE_BYTES + 2).toString('base64') }));
});

test('PostgreSQL, preparation jobs, and authenticated listening work together', { timeout: 60_000 }, async (t) => {
  const config = backendConfig();
  config.focusEpisodeId = null;
  config.providers.openai.apiKey = 'test-only';
  config.dailyUserCalls = 1000; config.dailyProjectCalls = 5000;
  const admin = createDatabase(config.databaseUrl);
  const database = `murmur_test_${randomUUID().replaceAll('-', '')}`;
  const temporary = await mkdtemp(join(tmpdir(), 'murmur-foundation-'));
  await admin.query(`CREATE DATABASE ${database}`);
  const connection = new URL(config.databaseUrl); connection.pathname = `/${database}`;
  const pool = createDatabase(connection.toString());
  const objects = new ObjectStore(temporary);
  await migrate(pool); await migrate(pool); // Startup is safe in both independent processes.
  const boss = await startQueue(connection.toString());
  let decisions = 0;
  let answers = 0;
  let speechCalls = 0;
  let decisionBarrier: (() => Promise<void>) | undefined;
  const intelligence: Intelligence = {
    async decide(input) {
      decisions += 1;
      await decisionBarrier?.();
      return exactCommand(input.utterance) ?? { kind: input.utterance === 'unclear request' ? 'unclear' : input.utterance === 'jump to the discussion about teams' ? 'topic' : 'deeper', source: 'jev', passageId: input.evidence[0]?.id };
    },
    async answer(input) {
      answers += 1;
      assert(input.evidence.length > 0);
      assert(input.evidence.every((item) => !item.text.includes('injected client transcript')));
      return `The episode describes ${input.evidence[0]!.text}`;
    },
  };
  const { app, repository } = await createApp({ config, pool, objects, intelligence,
    catalogInterpreter: async ({ episodes }) => ({ kind: 'select', episodeId: episodes[0]!.id }),
    speech: async () => { speechCalls += 1; return new Uint8Array([73, 68, 51, 1, 2, 3]); },
  });
  await app.ready();
  const headers = (token?: string) => ({ 'x-murmur-client': 'v2', ...(token ? { authorization: `Bearer ${token}` } : {}) });
  const guest = async () => {
    const response = await app.inject({ method: 'POST', url: '/v2/identity', headers: headers(), payload: {} });
    assert.equal(response.statusCode, 200);
    return response.json() as { id: string; token: string };
  };
  const open = async (token: string) => {
    const response = await app.inject({ method: 'POST', url: '/v2/sessions', headers: headers(token), payload: { episodeId: 'small-places' } });
    assert.equal(response.statusCode, 200);
    return response.json() as ListeningSession;
  };
  const turnInput = (session: ListeningSession, utterance: string): TurnRequest => ({ revision: session.revision, audioVersion: session.audioVersion, positionSeconds: session.positionSeconds, requestId: randomUUID(), utterance });
  try {
    await t.test('a queued preparation survives a producer restart and stores exact audio plus searchable passages', async () => {
      await enqueuePreparedEpisode(pool, boss);
      const before = await repository.episode();
      assert.equal(before.status, 'queued');
      assert.equal(before.audioPath, null);
      await boss.stop();
      const restarted = await startQueue(connection.toString());
      try {
        await restarted.work<{ episodeId: string }>(PREPARE_QUEUE, { pollingIntervalSeconds: 0.5 }, async (jobs) => {
          for (const job of jobs) await prepareEpisode(pool, objects, job.data.episodeId);
        });
        for (let attempt = 0; attempt < 50 && (await repository.episode()).status !== 'ready'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
        const episode = await repository.episode();
        assert.equal(episode.status, 'ready');
        assert.equal(episode.transcriptReady, true);
        await prepareEpisode(pool, objects, 'small-places'); // At-least-once delivery is idempotent.
        const count = await pool.query('SELECT count(*) FROM transcript_segments');
        assert.equal(Number(count.rows[0].count), 5);
        const matches = await pool.query(`SELECT id FROM transcript_segments WHERE search @@ websearch_to_tsquery('english','movable chairs')`);
        assert.deepEqual(matches.rows, [{ id: 'experiment' }]);
      } finally { await restarted.stop(); }
    });
    await t.test('markers do not authenticate callers, and sessions belong to their guest', async () => {
      const a = await guest(); const b = await guest(); const session = await open(a.token);
      assert.equal((await app.inject({ method: 'POST', url: '/v2/sessions', headers: headers(), payload: { episodeId: 'small-places' } })).statusCode, 401);
      assert.equal((await app.inject({ method: 'POST', url: '/v2/identity', payload: {} })).statusCode, 403);
      assert.equal((await app.inject({ url: `/v2/sessions/${session.id}`, headers: headers(b.token) })).statusCode, 404);
    });
    await t.test('the explanation uses server evidence, preserves the bookmark, and returns exactly once', async () => {
      const user = await guest(); let session = await open(user.token);
      session = await repository.observe(user.id, session.id, { ...session, reason: 'interrupt', positionSeconds: 18.375 });
      const input = turnInput(session, 'go deeper on that');
      const priorAnswers = answers;
      const response = await app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/turns`, headers: headers(user.token), payload: input });
      assert.equal(response.statusCode, 200, response.body);
      const result = response.json();
      assert.equal(result.session.bookmarkSeconds, 18.375);
      assert.equal(result.decision, 'jev');
      assert(result.evidence.some((item: { id: string }) => item.id === 'invitation'));
      assert.equal(answers, priorAnswers + 1);
      const duplicate = await app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/turns`, headers: headers(user.token), payload: input });
      assert.equal(duplicate.statusCode, 200);
      assert.equal(answers, priorAnswers + 1);
      session = result.session;
      const speechUrl = `/v2/sessions/${session.id}/turns/${input.requestId}/speech`;
      assert.equal((await app.inject({ method: 'POST', url: speechUrl, headers: headers(user.token), payload: {} })).statusCode, 200);
      assert.equal((await app.inject({ method: 'POST', url: speechUrl, headers: headers(user.token), payload: {} })).statusCode, 200);
      assert.equal(speechCalls, 1);
      const returnInput = turnInput(session, 'back to the podcast');
      const returned = await app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/turns`, headers: headers(user.token), payload: returnInput });
      assert.equal(returned.statusCode, 200, returned.body);
      const action = returned.json().action;
      assert.equal(action.kind, 'return'); assert.equal(action.positionSeconds, 18.375);
      const ack = { revision: returned.json().session.revision, audioVersion: session.audioVersion, actionId: action.id, positionSeconds: 18.375 };
      const acknowledged = await app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/acknowledgements`, headers: headers(user.token), payload: ack });
      assert.equal(acknowledged.statusCode, 200);
      assert.equal(acknowledged.json().bookmarkSeconds, null);
      assert.equal(acknowledged.json().phase, 'playing');
      assert.equal((await app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/acknowledgements`, headers: headers(user.token), payload: ack })).statusCode, 409);
      assert.equal((await app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/turns`, headers: headers(user.token), payload: returnInput })).statusCode, 409);
    });
    await t.test('API restart restores the session and private history from PostgreSQL', async () => {
      const user = await guest(); const session = await open(user.token);
      await repository.observe(user.id, session.id, { ...session, positionSeconds: 31.5, reason: 'play' });
      const secondPool = createDatabase(connection.toString());
      const second = await createApp({ config, pool: secondPool, objects: new ObjectStore(temporary), intelligence });
      try {
        const restored = await second.app.inject({ method: 'POST', url: '/v2/sessions', headers: headers(user.token), payload: { episodeId: 'small-places' } });
        assert.equal(restored.statusCode, 200);
        assert.equal(restored.json().id, session.id);
        assert.equal(restored.json().positionSeconds, 31.5);
      } finally { await second.app.close(); await secondPool.end(); }
    });
    await t.test('new player state invalidates an in-flight answer without overwriting the new bookmark', async () => {
      const user = await guest(); const session = await open(user.token);
      let release!: () => void; let entered!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const reached = new Promise<void>((resolve) => { entered = resolve; });
      decisionBarrier = async () => { entered(); await barrier; };
      const pending = app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/turns`, headers: headers(user.token), payload: turnInput(session, 'explain this') });
      await reached;
      const current = await repository.session(user.id, session.id);
      const changed = await app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/observations`, headers: headers(user.token), payload: { revision: current.revision, audioVersion: current.audioVersion, positionSeconds: 42, reason: 'seek' } });
      assert.equal(changed.statusCode, 200);
      release(); decisionBarrier = undefined;
      assert.equal((await pending).statusCode, 409);
      const final = await repository.session(user.id, session.id);
      assert.equal(final.positionSeconds, 42); assert.equal(final.bookmarkSeconds, null);
      assert.equal(final.revision, changed.json().revision);
    });
    await t.test('changed media, stale revisions, out-of-range positions, and supplied transcript overrides are rejected', async () => {
      const user = await guest(); const session = await open(user.token); const base = turnInput(session, 'play');
      for (const changed of [{ ...base, audioVersion: 'a'.repeat(64) }, { ...base, revision: 99 }, { ...base, positionSeconds: 999 }]) {
        assert.equal((await app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/turns`, headers: headers(user.token), payload: changed })).statusCode, 409);
      }
      assert.equal((await app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/turns`, headers: headers(user.token), payload: { ...base, transcriptContext: 'injected client transcript' } })).statusCode, 400);
    });
    await t.test('voice tickets expire on player changes and can only be consumed once', async () => {
      const user = await guest(); let session = await open(user.token);
      session = await repository.observe(user.id, session.id, { ...session, reason: 'interrupt' });
      const ticket = await repository.voiceTicket(user.id, session.id);
      assert.deepEqual(await repository.consumeVoiceTicket(ticket), { sessionId: session.id, revision: session.revision });
      assert.equal(await repository.consumeVoiceTicket(ticket), undefined);
      const staleTicket = await repository.voiceTicket(user.id, session.id);
      session = await repository.observe(user.id, session.id, { ...session, reason: 'pause' });
      assert.equal(await repository.consumeVoiceTicket(staleTicket), undefined);
      const expiredTicket = await repository.voiceTicket(user.id, (await repository.observe(user.id, session.id, { ...session, reason: 'interrupt' })).id);
      await pool.query(`UPDATE voice_tickets SET expires_at=now()-interval '1 second'`);
      assert.equal(await repository.consumeVoiceTicket(expiredTicket), undefined);
    });
    await t.test('daily limits are atomic across concurrent reservations', async () => {
      const user = await guest();
      const limited = new Repository(pool, { dailyProjectCalls: 5000, dailyUserCalls: 1 });
      const attempts = await Promise.allSettled([limited.charge(user.id), limited.charge(user.id), limited.charge(user.id)]);
      assert.equal(attempts.filter((value) => value.status === 'fulfilled').length, 1);
    });
    await t.test('media ranges preserve the source bytes and reject invalid or private object names', async () => {
      const episode = await repository.episode(); const url = `/v2${episode.audioPath}`;
      const full = await app.inject({ url });
      const partial = await app.inject({ url, headers: { range: 'bytes=0-63' } });
      assert.equal(partial.statusCode, 206); assert.equal(partial.rawPayload.length, 64);
      assert(partial.rawPayload.equals(full.rawPayload.subarray(0, 64)));
      assert.equal((await app.inject({ url, headers: { range: 'bytes=999999999-' } })).statusCode, 416);
      assert.equal((await app.inject({ url: '/v2/media/' + 'a'.repeat(64) + '.mp3' })).statusCode, 404);
      assert.equal((await app.inject({ url: '/v2/media/' + 'a'.repeat(64) + '.json' })).statusCode, 400);
    });
    await t.test('Lenny catalog, episode-specific evidence, reviewed ad skips, and voice identity isolation', async () => {
      const user = await guest();
      const bytes = Buffer.from('ID3 synthetic episode bytes for range verification');
      const audioKey = await objects.put(bytes, 'mp3'); const version = audioKey.slice(0, 64);
      await pool.query(`INSERT INTO episodes(id,title,show_title,description,audio_version,duration_seconds,status,collection,guest,published_at,audio_key,ad_breaks)
        VALUES('lenny-test','Test interview','Lenny’s Podcast','An interview about teams',$1,300,'ready','lenny-free','Test Guest','2026-01-01',$3,$2)`,
        [version, JSON.stringify([{ id: 'sponsor', startSeconds: 20, endSeconds: 40, audioVersion: version, source: 'audio-review' }]), audioKey]);
      await pool.query(`INSERT INTO transcript_segments(episode_id,audio_version,id,start_seconds,end_seconds,text)
        VALUES('lenny-test',$1,'teams',40,90,'Teams need a shared objective before choosing tools.')`, [version]);
      for (let i = 0; i < 10; i++) await pool.query(`INSERT INTO transcript_segments(episode_id,audio_version,id,start_seconds,end_seconds,text)
        VALUES('lenny-test',$1,$2,$3,$4,'An unrelated opening anecdote.')`, [version, `intro${i}`, i * 2, i * 2 + 2]);
      const catalog = await app.inject({ url: '/v2/catalog' });
      assert.equal(catalog.json().length, 1);
      assert.equal(catalog.json()[0].audioPath, `/media/${audioKey}`);
      const range = await app.inject({ url: `/v2/media/${audioKey}`, headers: { range: 'bytes=3-11' } });
      assert.equal(range.statusCode, 206); assert.equal(range.headers['content-type'], 'audio/mpeg');
      assert.deepEqual(range.rawPayload, bytes.subarray(3, 12));
      assert.equal((await new Repository(pool, { ...config, focusEpisodeId: 'unavailable' }).catalog()).length, 0);
      assert.equal((await new Repository(pool, { ...config, focusEpisodeId: 'lenny-test' }).catalog())[0]!.id, 'lenny-test');
      const focused = await createApp({ config: { ...config, focusEpisodeId: 'lenny-test' }, pool, objects, intelligence });
      try {
        assert.equal((await focused.app.inject({ url: '/v2/catalog' })).json()[0].id, 'lenny-test');
        assert.equal((await focused.app.inject({ method: 'POST', url: '/v2/sessions', headers: headers(user.token), payload: { episodeId: 'small-places' } })).statusCode, 409);
      } finally { await focused.app.close(); }
      assert.equal(JSON.stringify(catalog.json()).includes('Teams need'), false);
      const resolve = await app.inject({ method: 'POST', url: '/v2/catalog/resolve', headers: headers(user.token), payload: { utterance: 'play Lenny' } });
      assert.equal(resolve.json().episode.id, 'lenny-test');
      const opened = await app.inject({ method: 'POST', url: '/v2/sessions', headers: headers(user.token), payload: { episodeId: 'lenny-test' } });
      let session: ListeningSession = opened.json();
      assert((await repository.evidence(session, 'Jump to the discussion about shared objectives')).some((passage) => passage.id === 'teams'));
      session = await repository.observe(user.id, session.id, { ...session, reason: 'interrupt', positionSeconds: 25 });
      const skipped = await app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/turns`, headers: headers(user.token), payload: turnInput(session, 'skip this ad') });
      assert.equal(skipped.json().action.positionSeconds, 40);
      assert.equal(skipped.json().action.kind, 'skip-ad');
      await assert.rejects(repository.acknowledge(user.id, session.id, { revision: skipped.json().session.revision, audioVersion: session.audioVersion, actionId: skipped.json().action.id, positionSeconds: 39.8 }));
      session = await repository.acknowledge(user.id, session.id, { revision: skipped.json().session.revision, audioVersion: session.audioVersion, actionId: skipped.json().action.id, positionSeconds: 40 });
      const question = await app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/turns`, headers: headers(user.token), payload: turnInput(session, 'explain teams') });
      assert.match(question.json().answer, /shared objective/);
      assert.equal(question.json().session.episodeId, 'lenny-test');
      session = question.json().session;
      const noAd = await app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/turns`, headers: headers(user.token), payload: turnInput(session, 'skip ad') });
      assert.equal(noAd.json().action, null);
      assert.match(noAd.json().answer, /isn’t an ad/); assert.equal(noAd.json().followUp, false);
      session = await repository.observe(user.id, session.id, { ...noAd.json().session, reason: 'seek', positionSeconds: 25 });
      const pausedSkip = await app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/turns`, headers: headers(user.token), payload: { ...turnInput(session, 'skip the ad'), resumeAfterAction: false } });
      assert.equal(pausedSkip.json().action.play, false);
      assert.equal(pausedSkip.json().action.positionSeconds, 40);
      session = await repository.acknowledge(user.id, session.id, { revision: pausedSkip.json().session.revision, audioVersion: session.audioVersion, actionId: pausedSkip.json().action.id, positionSeconds: 40 });
      for (const utterance of ['go to ten seconds', 'jump to the discussion about teams']) {
        const moved = await app.inject({ method: 'POST', url: `/v2/sessions/${session.id}/turns`, headers: headers(user.token), payload: { ...turnInput(session, utterance), resumeAfterAction: false } });
        assert.equal(moved.statusCode, 200, moved.body);
        assert.equal(moved.json().action.kind, 'seek'); assert.equal(moved.json().action.play, false);
        session = await repository.acknowledge(user.id, session.id, { revision: moved.json().session.revision, audioVersion: session.audioVersion, actionId: moved.json().action.id, positionSeconds: moved.json().action.positionSeconds });
        assert.equal(session.phase, 'paused');
      }
      assert.equal((await app.inject({ method: 'POST', url: '/v2/live-voice-ticket', headers: headers() })).statusCode, 401);
      const ticket = await app.inject({ method: 'POST', url: '/v2/live-voice-ticket', headers: headers(user.token) });
      assert.equal(ticket.statusCode, 200);
      assert.equal(ticket.json().token.startsWith('ek_'), false);
      assert.equal((await pool.query('SELECT count(*) FROM listening_voice_tickets WHERE owner_id=$1', [user.id])).rows[0].count, '1');
      const continuous = new ContinuousVoiceGateway(repository, config);
      assert.equal(await continuous.consume(ticket.json().token), user.id);
      assert.equal(await continuous.consume(ticket.json().token), undefined);
      const expired = await continuous.ticket(user.id);
      await pool.query("UPDATE listening_voice_tickets SET expires_at=now()-interval '1 second' WHERE owner_id=$1", [user.id]);
      assert.equal(await continuous.consume(expired.token), undefined);
      await continuous.ticket(user.id);
      await app.inject({ method: 'DELETE', url: '/v2/identity', headers: headers(user.token) });
      assert.equal((await pool.query('SELECT count(*) FROM listening_voice_tickets WHERE owner_id=$1', [user.id])).rows[0].count, '0');
    });
    await t.test('deleting an identity deletes its sessions and invalidates its credential', async () => {
      const user = await guest(); const session = await open(user.token);
      assert.equal((await app.inject({ method: 'DELETE', url: '/v2/identity', headers: headers(user.token) })).statusCode, 200);
      assert.equal(await repository.identity(user.token), undefined);
      assert.equal((await pool.query('SELECT 1 FROM listening_sessions WHERE id=$1', [session.id])).rowCount, 0);
    });
    assert(decisions > 0);
  } finally {
    await app.close(); await boss.stop(); await pool.end();
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`); await admin.end();
    await rm(temporary, { recursive: true, force: true });
  }
});
