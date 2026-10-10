import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { backendConfig } from './config';
import { createDatabase } from './database';
import { createIntelligence } from './intelligence';
import { createCatalogInterpreter } from './catalog-interpreter';
import { Repository } from './repository';
import { createAdClassifier } from './ad-preprocessing';
import type { ListeningSession } from '../shared/listening';

test('spoken ad-mode requests survive real transcription', { skip: process.env.MURMUR_LIVE_AD_AUDIO !== '1', timeout: 180_000 }, async () => {
  const { synthesizeAudio, transcribeAudio } = await import('../src/server/openai-audio/provider');
  const config = backendConfig();
  const pool = createDatabase(config.databaseUrl);
  try {
    const episodes = await new Repository(pool, config).catalog();
    const episode = episodes[0]!;
    const session: ListeningSession = { id: randomUUID(), episodeId: episode.id, audioVersion: episode.audioVersion, revision: 0, positionSeconds: 210, bookmarkSeconds: 210, phase: 'listening', pendingAction: null };
    const intelligence = createIntelligence(config);
    const interpret = createCatalogInterpreter(config.providers.typesafe);
    for (const [words, expected] of [
      ['Can you remove all ads from this podcast?', true],
      ['I would like to listen without commercials.', true],
      ['Please stop skipping ads.', false],
    ] as const) {
      const options = { config: { ...config.providers.openai, apiKey: config.providers.openai.apiKey ?? null }, signal: AbortSignal.timeout(45_000) };
      const audio = await synthesizeAudio(words, options);
      const utterance = await transcribeAudio(new File([new Uint8Array(audio)], 'ad-request.mp3', { type: 'audio/mpeg' }), options);
      assert.equal((await interpret({ utterance, currentEpisodeId: episode.id, history: [], episodes }, options.signal)).kind, 'current', utterance);
      const decision = await intelligence.decide({ utterance, session, evidence: [], history: [] }, options.signal);
      assert.equal(decision.kind, 'set-ad-skipping', utterance);
      assert.equal(decision.enabled, expected, utterance);
    }
  } finally { await pool.end(); }
});

test('live semantic ad requests route to current episode and assign mode without phrase shortcuts', { skip: process.env.MURMUR_LIVE_ADS !== '1', timeout: 120_000 }, async () => {
  const config = backendConfig();
  const pool = createDatabase(config.databaseUrl);
  try {
    const repo = new Repository(pool, config);
    const episodes = await repo.catalog();
    const episode = episodes[0]!;
    const session: ListeningSession = { id: randomUUID(), episodeId: episode.id, audioVersion: episode.audioVersion, revision: 0, positionSeconds: 210, bookmarkSeconds: 210, phase: 'listening', pendingAction: null };
    const intelligence = createIntelligence(config);
    const interpret = createCatalogInterpreter(config.providers.typesafe);
    for (const [utterance, expected] of [
      ['Can you remove all ads from this podcast?', true], ['Can I listen without commercials?', true],
      ['Keep the ads after all', false], ['Do not remove the ads', false], ['Stop skipping ads', false],
    ] as const) {
      const signal = AbortSignal.timeout(20_000);
      assert.equal((await interpret({ utterance, currentEpisodeId: episode.id, history: [], episodes }, signal)).kind, 'current', utterance);
      const decision = await intelligence.decide({ utterance, session, evidence: [], history: [] }, signal);
      assert.equal(decision.kind, 'set-ad-skipping', utterance);
      assert.equal(decision.enabled, expected, utterance);
    }
    for (const utterance of ['How do podcast ads work?', 'Why does the guest advertise their business?']) {
      const decision = await intelligence.decide({ utterance, session, evidence: [], history: [] }, AbortSignal.timeout(20_000));
      assert.notEqual(decision.kind, 'set-ad-skipping', utterance);
    }
    assert.equal((await intelligence.decide({ utterance: 'Skip this sponsor', session, evidence: [], history: [] }, AbortSignal.timeout(20_000))).kind, 'skip-ad');
    assert.equal((await intelligence.decide({ utterance: 'Please move back two minutes', session, evidence: [], history: [] }, AbortSignal.timeout(20_000))).delta, -120);
  } finally { await pool.end(); }
});

test('live transcript classifier separates sponsor reads from discussion of sponsors', { skip: process.env.MURMUR_LIVE_ADS !== '1', timeout: 120_000 }, async () => {
  const config = backendConfig();
  const pool = createDatabase(config.databaseUrl);
  try {
    const classify = createAdClassifier(config);
    for (const [guest, start, isAd] of [['Cat Wu', 2740, true], ['Benedict Evans', 2224, true], ['Dan Shipper', 5548, false], ['Elena Verna', 3188, false]] as const) {
      const rows = await pool.query(`SELECT t.id,t.start_seconds AS "startSeconds",t.end_seconds AS "endSeconds",t.text
        FROM transcript_segments t JOIN episodes e ON e.id=t.episode_id AND e.audio_version=t.audio_version
        WHERE (e.guest=$1 OR ($1='Cat Wu' AND e.guest='Kat Wu')) AND t.start_seconds=$2`, [guest, start]);
      assert.equal(rows.rows.length, 1, `Expected corpus passage for ${guest}`);
      const judgment = (await classify(rows.rows, AbortSignal.timeout(30_000)))[0]!;
      assert.equal(judgment.classification === 'advertisement' && judgment.probability >= 0.9, isAd, guest);
    }
  } finally { await pool.end(); }
});
