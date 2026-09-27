import assert from 'node:assert/strict';
import test from 'node:test';
import { GET } from '../../app/api/v2/[...path]+api';

test('the Expo bridge preserves the recording version and identity for captions', async () => {
  const original = globalThis.fetch;
  const version = 'a'.repeat(64);
  let called = false;
  globalThis.fetch = async (input, init) => {
    called = true;
    const url = new URL(String(input));
    assert.equal(url.pathname, '/v2/catalog/lenny-one/captions');
    assert.equal(url.searchParams.get('audioVersion'), version);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-token');
    return Response.json({ audioVersion: version, cues: [] });
  };
  try {
    const response = await GET(new Request(`http://localhost/api/v2/catalog/lenny-one/captions?audioVersion=${version}`, { headers: { authorization: 'Bearer test-token' } }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).audioVersion, version);
    assert(called);
  } finally { globalThis.fetch = original; }
});
