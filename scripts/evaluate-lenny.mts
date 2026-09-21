import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ListeningSession } from '../shared/listening';

// Opt-in live catalog, ad-condition, answer, and speech evaluation. Uses credits.
const base = process.env.MURMUR_BACKEND_URL ?? 'http://127.0.0.1:4545';
let token = '';
async function request(path: string, body?: unknown, method = body ? 'POST' : 'GET') {
  const response = await fetch(`${base}/v2${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Murmur-Client': 'v2', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response;
}
const identity = await (await request('/identity', {})).json(); token = identity.token;
try {
  const catalog = await (await request('/catalog')).json(); assert([1, 50].includes(catalog.length));
  const focused = catalog.length === 1;
  const episodeId = focused ? 'lenny-brian-halligan' : 'lenny-simon-willison';
  for (const [utterance, kind, expectedEpisode] of [
    [focused ? 'Play Brian Halligan' : 'Play the Simon Willison episode', 'play', episodeId],
    ['Find the episode with Brian Halligan', 'play', 'lenny-brian-halligan'],
    ['Play the Daily', 'clarify', undefined],
    ['Play an episode of Radiolab', 'clarify', undefined],
    ['Explain what he just said', 'current', undefined],
    ['Play Lenny', 'play', undefined],
  ] as const) {
    const start = performance.now();
    const result = await (await request('/catalog/resolve', { utterance, currentEpisodeId: focused ? 'lenny-brian-halligan' : 'lenny-simon-willison', history: [] })).json();
    assert.equal(result.kind, kind, `${utterance}: ${JSON.stringify(result)}`);
    if (expectedEpisode) assert.equal(result.episode.id, expectedEpisode);
    console.log(`${utterance}: ${result.kind} (${Math.round(performance.now() - start)}ms)`);
  }
  let session: ListeningSession = await (await request('/sessions', { episodeId })).json();
  if (focused) {
    for (const [position, expected, playing] of [[2229.999, false, true], [2230, true, true], [2250.375, true, false], [2289.999, true, true], [2290, false, true]] as const) {
      session = await (await request(`/sessions/${session.id}/observations`, { revision: session.revision, audioVersion: session.audioVersion, reason: 'seek', positionSeconds: position })).json();
      const turn = await (await request(`/sessions/${session.id}/turns`, { revision: session.revision, audioVersion: session.audioVersion, positionSeconds: position, requestId: randomUUID(), utterance: 'skip this ad', resumeAfterAction: playing })).json();
      if (expected) {
        assert.equal(turn.action.kind, 'skip-ad'); assert.equal(turn.action.positionSeconds, 2290); assert.equal(turn.action.play, playing);
        session = await (await request(`/sessions/${session.id}/acknowledgements`, { revision: turn.session.revision, audioVersion: session.audioVersion, positionSeconds: 2290, actionId: turn.action.id })).json();
      } else { assert.equal(turn.action, null); assert.equal(turn.followUp, false); session = turn.session; }
    }
    console.log('Ad boundaries, repeated skips, and paused skips: passed.');
  }
  const position = focused ? 2300 : 365;
  session = await (await request(`/sessions/${session.id}/observations`, { revision: session.revision, audioVersion: session.audioVersion, reason: 'seek', positionSeconds: position })).json();
  const result = await (await request(`/sessions/${session.id}/turns`, { revision: session.revision, audioVersion: session.audioVersion, positionSeconds: position, requestId: randomUUID(), utterance: focused ? 'What does Brian mean by Halliganisms?' : 'What does Simon mean by agentic engineering?' })).json();
  assert.equal(result.action, null); assert(result.evidence.length > 0); assert(result.answer.length > 0);
  assert.equal(result.session.bookmarkSeconds, position);
  const speech = await request(`/sessions/${session.id}/turns/${result.requestId}/speech`, {});
  assert.equal(speech.headers.get('x-murmur-voice-disclosure'), 'ai-generated');
  assert((await speech.arrayBuffer()).byteLength > 1000);
  console.log('Episode-grounded answer, speech, and saved position: passed.');
} finally { await request('/identity', {}, 'DELETE'); }
