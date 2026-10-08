import assert from 'node:assert/strict';
import test from 'node:test';
import { timeCandidates, exactTimeSeek } from './time-seek';
import { backendConfig } from './config';
import { createIntelligence, playbackAction } from './intelligence';
import type { ListeningSession } from '../shared/listening';
import type { askChoices, ChoiceQuestion, ChoiceAnswer } from '../src/server/typesafe/client';

const session: ListeningSession = { id: 'test-session', episodeId: 'any-episode', audioVersion: 'a'.repeat(64), revision: 0, positionSeconds: 900, bookmarkSeconds: 900, phase: 'listening', pendingAction: null };

test('durations support arbitrary amounts, units, fractions and compound times', () => {
  for (const [text, seconds] of [
    ['30 seconds', 30], ['ninety seconds', 90], ['17 minutes', 1020],
    ['two hours', 7200], ['1.5 hours', 5400], ['an hour and a half', 5400],
    ['half a minute', 30], ['two and a half minutes', 150],
    ['one hour twenty minutes and thirty seconds', 4830],
    ['one hour, twenty minutes, and thirty seconds', 4830],
    ['one point five hours', 5400], ['1,000 seconds', 1000],
    ['one hundred and twenty seconds', 120], ['7200 seconds', 7200],
    ['1:02:03', 3723], ['37:00', 2220],
  ] as const) assert.equal(timeCandidates(`Could you move ahead ${text} please`)[0]?.seconds, seconds, text);
});

test('fast paths distinguish relative and absolute jumps without imposing a ten-minute cap', () => {
  for (const [text, expected] of [
    ['skip 30 seconds', { delta: 30 }], ['rewind two minutes', { delta: -120 }],
    ['go forward two hours', { delta: 7200 }], ['jump to one hour', { position: 3600 }],
    ['go to thirty-seven minutes', { position: 2220 }], ['skip ahead 1.5 minutes', { delta: 90 }],
  ] as const) assert.deepEqual(exactTimeSeek(text), expected, text);
});

test('transcription punctuation preserves the complete time candidate', () => {
  for (const suffix of ['.', '?', '!', ', please.']) {
    assert.equal(timeCandidates(`Please move back two minutes${suffix}`)[0]?.seconds, 120);
  }
  assert.equal(timeCandidates('go to 1:23.4').length, 0);
});

test('ambiguous, negated, malformed and explanatory requests are not fast-path commands', () => {
  for (const text of ['do not skip 30 seconds', 'why did you skip 30 seconds', 'skip 30',
    'skip -30 seconds', 'skip 1:99', 'skip two minutes or three minutes', 'skip zero seconds']) {
    assert.equal(exactTimeSeek(text), undefined, text);
  }
  assert.equal(timeCandidates('skip -30 seconds').length, 0);
  assert.equal(timeCandidates('skip 1:99').length, 0);
});

test('semantic seek uses selected source amount and direction, with confidence gates', async () => {
  const config = backendConfig(); config.providers.typesafe.apiKey = 'test-only';
  for (const mode of ['forward', 'backward', 'absolute', 'none']) {
    for (const probability of [0.5, 1]) {
      const choices: typeof askChoices = async <K extends string>(state: unknown, questions: Record<K, ChoiceQuestion>) => {
        assert.deepEqual((state as { timeCandidates: { seconds: number }[] }).timeCandidates.map((time) => time.seconds), [5400]);
        return Object.fromEntries(Object.entries<ChoiceQuestion>(questions).map(([key, question]) => {
          const selected = key === 'action' ? 'seek' : key === 'seekMode' ? mode : key === 'timeTarget' ? 'time_0' : key === 'passage' ? 'none' : 'unspecified';
          return [key, { choice: selected, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map((option) => [option, option === selected ? key === 'timeTarget' ? probability : 1 : 0])) }];
        })) as Record<K, ChoiceAnswer>;
      };
      const result = await createIntelligence(config, choices).decide({ utterance: 'Could you move by an hour and a half please', session, evidence: [], history: [] }, new AbortController().signal);
      if (mode === 'none' || probability < 0.7) assert.equal(result.kind, 'unclear');
      else assert.deepEqual(result, { kind: 'seek', source: 'jev', ...(mode === 'absolute' ? { position: 5400 } : { delta: mode === 'forward' ? 5400 : -5400 }) });
    }
  }
});

test('seek bounds use each episode duration and never wrap around', () => {
  for (const duration of [1200, 10000]) {
    assert.equal(playbackAction({ kind: 'seek', source: 'code', delta: 7200 }, session, duration)?.positionSeconds, Math.min(duration, 8100));
    assert.equal(playbackAction({ kind: 'seek', source: 'code', delta: -7200 }, session, duration)?.positionSeconds, 0);
  }
});

test('live natural-language seek handles amounts without episode-specific rules', { skip: process.env.MURMUR_LIVE_SEMANTICS !== '1' }, async () => {
  const intelligence = createIntelligence(backendConfig());
  const cases = [
    ['Could you take me forward by thirty seconds please', 'delta', 30],
    ['I missed that, take me back two minutes please', 'delta', -120],
    ['Please move back two minutes.', 'delta', -120],
    ['Can we move ahead an hour and a half', 'delta', 5400],
    ['Please take me to the one hour twenty minutes mark', 'position', 4800],
    ['Move ahead two minutes and thirty seconds please', 'delta', 150],
  ] as const;
  for (const [utterance, field, expected] of cases) {
    const result = await intelligence.decide({ utterance, session, evidence: [], history: [] }, new AbortController().signal);
    assert.equal(result.kind, 'seek', utterance);
    assert.equal(result[field], expected, utterance);
  }
  for (const utterance of ['Do not skip thirty seconds', 'What did he mean at two minutes?', 'Skip two minutes or three minutes, I am not sure']) {
    const result = await intelligence.decide({ utterance, session, evidence: [], history: [] }, new AbortController().signal);
    assert.notEqual(result.kind, 'seek', utterance);
  }
});

test('live catalog-to-turn-to-acknowledgement seeks preserve playback state across episodes', { skip: process.env.MURMUR_LIVE_SEMANTICS !== '1' }, async () => {
  const { randomUUID } = await import('node:crypto');
  const { Pool } = await import('pg');
  const { createApp } = await import('./app');
  const { ObjectStore } = await import('./storage');
  const config = backendConfig(); config.focusEpisodeId = null;
  const pool = new Pool({ connectionString: config.databaseUrl });
  const { app } = await createApp({ config, pool, objects: new ObjectStore(config.objectDirectory) });
  let token = '';
  const headers = () => ({ 'x-murmur-client': 'v2', authorization: `Bearer ${token}` });
  const post = async (url: string, payload: Record<string, unknown>) => {
    const response = await app.inject({ method: 'POST', url, headers: headers(), payload });
    assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
    return response.json();
  };
  try {
    token = (await post('/v2/identity', {})).token;
    const catalog = (await app.inject('/v2/catalog')).json();
    const episodes = catalog.filter((episode: { status: string }) => episode.status === 'ready').slice(0, 2);
    assert.equal(episodes.length, 2);
    for (const episode of episodes) {
      let current = await post('/v2/sessions', { episodeId: episode.id });
      for (const resumeAfterAction of [false, true]) {
        for (const [utterance, relative, amount] of [
          ['skip 30 seconds', true, 30], ['Could you take me back two minutes please', true, -120],
          ['Can we move ahead an hour and a half', true, 5400], ['Please take me to the two minutes mark', false, 120],
        ] as const) {
          current = await post(`/v2/sessions/${current.id}/observations`, { revision: current.revision, audioVersion: current.audioVersion, positionSeconds: 300, reason: 'interrupt' });
          const resolved = await post('/v2/catalog/resolve', { utterance, currentEpisodeId: episode.id, history: [] });
          assert.equal(resolved.kind, 'current', utterance);
          const turn = await post(`/v2/sessions/${current.id}/turns`, { revision: current.revision, audioVersion: current.audioVersion, positionSeconds: 300, requestId: randomUUID(), utterance, resumeAfterAction });
          assert.equal(turn.action?.kind, 'seek', utterance);
          assert.equal(turn.action.play, resumeAfterAction);
          assert.equal(turn.action.positionSeconds, Math.max(0, Math.min(episode.durationSeconds, relative ? 300 + amount : amount)));
          current = await post(`/v2/sessions/${current.id}/acknowledgements`, { revision: turn.session.revision, audioVersion: current.audioVersion, actionId: turn.action.id, positionSeconds: turn.action.positionSeconds });
          assert.equal(current.phase, resumeAfterAction ? 'playing' : 'paused');
        }
      }
    }
  } finally {
    if (token) await app.inject({ method: 'DELETE', url: '/v2/identity', headers: headers() });
    await app.close(); await pool.end();
  }
});

test('generated audio survives transcription into time-seek decisions', { skip: process.env.MURMUR_LIVE_SEEK_AUDIO !== '1' }, async () => {
  const { synthesizeAudio, transcribeAudio } = await import('../src/server/openai-audio/provider');
  const config = backendConfig();
  const intelligence = createIntelligence(config);
  for (const [words, expected] of [
    ['Could you skip ahead thirty seconds please?', 30],
    ['Please move back two minutes.', -120],
    ['Can you move forward an hour and a half?', 5400],
  ] as const) {
    const options = { config: { ...config.providers.openai, apiKey: config.providers.openai.apiKey ?? null }, signal: AbortSignal.timeout(45_000) };
    const bytes = await synthesizeAudio(words, options);
    const transcript = await transcribeAudio(new File([new Uint8Array(bytes)], 'seek.mp3', { type: 'audio/mpeg' }), options);
    const result = await intelligence.decide({ utterance: transcript, session, evidence: [], history: [] }, options.signal);
    assert.equal(result.kind, 'seek', transcript);
    assert.equal(result.delta, expected, transcript);
  }
});
