import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const base = process.env.MURMUR_BACKEND_URL ?? 'http://127.0.0.1:4545/v2';
let token = '';
async function request(path: string, body = {}, method = 'POST') {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Murmur-Client': 'v2', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  assert(response.ok, `${path}: ${response.status}`);
  return response.json();
}
token = (await request('/identity')).token;
try {
  for (let round = 0; round < 2; round++) {
    for (const [utterance, restart] of [
      ['Play from beginning', true], ['Play it from the very beginning', true], ['Can you take this episode back to the start and play it?', true],
      ['I missed the opening, let me hear this one from the top', true], ['Do not start over, keep my place', false], ['What did he mean at the beginning?', false],
    ] as const) {
      let session = await request('/sessions', { episodeId: 'lenny-brian-halligan' });
      session = await request(`/sessions/${session.id}/observations`, { revision: session.revision, audioVersion: session.audioVersion, reason: 'seek', positionSeconds: 600 });
      session = await request(`/sessions/${session.id}/observations`, { revision: session.revision, audioVersion: session.audioVersion, reason: 'interrupt', positionSeconds: 600 });
      const route = await request('/catalog/resolve', { utterance, currentEpisodeId: session.episodeId, history: [] });
      assert.equal(route.kind, 'current', utterance);
      const turn = await request(`/sessions/${session.id}/turns`, { utterance, requestId: randomUUID(), revision: session.revision, audioVersion: session.audioVersion, positionSeconds: 600 });
      if (restart) {
        assert.equal(turn.action?.kind, 'seek', utterance);
        assert.equal(turn.action.positionSeconds, 0); assert.equal(turn.action.play, true);
        const saved = await request(`/sessions/${session.id}/acknowledgements`, { revision: turn.session.revision, audioVersion: session.audioVersion, actionId: turn.action.id, positionSeconds: 0 });
        assert.equal(saved.positionSeconds, 0); assert.equal(saved.bookmarkSeconds, null);
      } else assert.notEqual(turn.action?.positionSeconds, 0, utterance);
      console.log(`PASS ${round + 1}: ${utterance}`);
    }
  }
} finally { await request('/identity', {}, 'DELETE'); }
