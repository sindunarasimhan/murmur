import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FOCUS_EPISODE_ID, FOCUS_INTRO_END } from '../backend/focus-episode';
import type { ListeningSession } from '../shared/listening';

const base = process.env.MURMUR_BACKEND_URL ?? 'http://127.0.0.1:4545';
let token = '';
async function request(path: string, body?: unknown, method = body ? 'POST' : 'GET') {
  const response = await fetch(`${base}/v2${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Murmur-Client': 'v2', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  assert(response.ok, `${path}: ${response.status} ${response.ok ? '' : await response.text()}`);
  return response.json();
}
token = (await request('/identity', {})).token;
try {
  let session: ListeningSession = await request('/sessions', { episodeId: FOCUS_EPISODE_ID });
  const cases = [
    { text: 'Skip the intro', position: 0, play: true, skip: true },
    { text: 'Get to the interview', position: 100, play: true, skip: true },
    { text: 'Start the actual conversation', position: 160, play: false, skip: true },
    { text: 'Can we get past the introductions?', position: 240, play: true, skip: true },
    { text: 'Skip the intro', position: FOCUS_INTRO_END, play: true, skip: false },
    { text: 'Skip the intro', position: 600, play: false, skip: false },
    { text: 'Do not skip the intro', position: 20, play: true, skip: false },
    { text: 'What did he say in the introduction?', position: 20, play: false, skip: false },
  ];
  for (let round = 1; round <= 3; round++) {
    for (const item of cases) {
      const route = await request('/catalog/resolve', { utterance: item.text, currentEpisodeId: FOCUS_EPISODE_ID, history: [] });
      assert.equal(route.kind, 'current', item.text);
      session = await request(`/sessions/${session.id}/observations`, { revision: session.revision, audioVersion: session.audioVersion, reason: 'seek', positionSeconds: item.position });
      const turn = await request(`/sessions/${session.id}/turns`, { revision: session.revision, audioVersion: session.audioVersion, positionSeconds: item.position, requestId: randomUUID(), utterance: item.text, resumeAfterAction: item.play });
      if (item.skip) {
        assert.equal(turn.action?.kind, 'skip-intro', item.text);
        assert.equal(turn.action.positionSeconds, FOCUS_INTRO_END);
        assert.equal(turn.action.play, item.play);
        session = await request(`/sessions/${session.id}/acknowledgements`, { revision: turn.session.revision, audioVersion: session.audioVersion, positionSeconds: FOCUS_INTRO_END, actionId: turn.action.id });
      } else {
        assert.equal(turn.action, null, item.text);
        session = turn.session;
      }
      console.log(`PASS round ${round}: ${item.text} at ${item.position}, ${item.play ? 'playing' : 'paused'}`);
    }
  }
  console.log('24/24 live routing, intent, boundary and acknowledgement cases passed. Phone audio not exercised.');
} finally { await request('/identity', {}, 'DELETE'); }
