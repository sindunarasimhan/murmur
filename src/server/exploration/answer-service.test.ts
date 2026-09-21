import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExploreRequest } from './explore-contract';
import { handleExplorePost } from './explore-handler';
import { EXPLORE_QUESTIONS } from './decision-policy';

const input: ExploreRequest = {
  question: 'What does handoff mean here?', intent: 'clarify', episode: { title: 'Teams', showTitle: 'Work' },
  playbackPositionSeconds: 25, transcriptContext: '[0:20–0:30; timed cue] A handoff transfers responsibility to another person.',
};
const environment = { OPENAI_API_KEY: 'openai-secret', TYPESAFE_API_KEY: 'typesafe-secret', OPENAI_RESPONSE_MODEL: 'standard', OPENAI_FAST_RESPONSE_MODEL: 'fast' };

function request(value = input, signal?: AbortSignal) {
  return new Request('http://localhost/api/explore', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Murmur-Client': 'expo' }, body: JSON.stringify(value), signal,
  });
}
function choice(key: keyof typeof EXPLORE_QUESTIONS, label: string, probability = 0.96) {
  const options = Object.keys(EXPLORE_QUESTIONS[key].criteria);
  return { type: 'choice', choice: label, confidence: probability,
    probabilities: Object.fromEntries(options.map(option => [option, option === label ? probability : (1 - probability) / (options.length - 1)])),
  };
}
function decisions(intent = 'clarify', probability = 0.96) {
  return { answers: { intent: choice('intent', intent, probability), effort: choice('effort', 'simple') } };
}

test('confident simple questions use an explicitly configured fast model with full evidence and no storage', async () => {
  const calls: string[] = [];
  const response = await handleExplorePost(request(), { environment, fetchImpl: async (url, init) => {
    calls.push(String(url));
    const payload = JSON.parse(String(init?.body));
    if (String(url).includes('typesafe')) {
      assert.equal(payload.state.excerpt, input.transcriptContext);
      return Response.json(decisions());
    }
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer openai-secret');
    assert.equal(payload.model, 'fast');
    assert.equal(payload.store, false);
    assert.match(payload.input, /transfers responsibility/);
    return Response.json({ status: 'completed', output_text: 'Responsibility passes to someone else.' });
  } });
  assert.equal(calls.length, 2);
  assert.equal(response.headers.get('X-Murmur-Decision'), 'jev');
  assert.equal((await response.json()).model, 'fast');
});

test('uncertain Jev intent keeps the original route and standard model', async () => {
  const response = await handleExplorePost(request(), { environment, fetchImpl: async (url, init) => {
    if (String(url).includes('typesafe')) return Response.json(decisions('debate', 0.45));
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.model, 'standard');
    assert.match(payload.input, /clarify/);
    return Response.json({ output_text: 'Answer.' });
  } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Murmur-Decision'), 'fallback');
});

test('follow-ups, metadata-only context, and numerical questions cannot take the fast route', async () => {
  for (const value of [
    { ...input, history: [{ question: 'Earlier?', answer: 'Earlier context.' }] },
    { ...input, transcriptContext: '[Context availability: episode metadata only. No usable timed transcript is available.]' },
    { ...input, intent: 'quantitative' as const },
  ]) {
    const response = await handleExplorePost(request(value), { environment, fetchImpl: async (url, init) => {
      if (String(url).includes('typesafe')) return Response.json(decisions());
      assert.equal(JSON.parse(String(init?.body)).model, 'standard');
      return Response.json({ output_text: 'Answer.' });
    } });
    assert.equal(response.status, 200);
  }
});

test('a confident substantive inquiry adjusts the answer guidance while retaining the standard model', async () => {
  const response = await handleExplorePost(request({ ...input, question: 'What is the strongest objection?' }), {
    environment, fetchImpl: async (url, init) => {
      if (String(url).includes('typesafe')) return Response.json(decisions('debate'));
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.model, 'standard');
      assert.match(payload.input, /debate/);
      return Response.json({ output_text: 'An objection.' });
    },
  });
  assert.equal(response.status, 200);
});

test('missing, rejected, or malformed Jev configuration never blocks an OpenAI answer', async () => {
  for (const mode of ['disabled', 'rejected', 'malformed']) {
    let openaiCalls = 0;
    const response = await handleExplorePost(request(), {
      environment: { ...environment, TYPESAFE_API_KEY: mode === 'disabled' ? '' : 'key' },
      fetchImpl: async (url, init) => {
        if (String(url).includes('typesafe')) {
          assert.notEqual(mode, 'disabled');
          return mode === 'rejected' ? new Response(null, { status: 401 }) : Response.json({ answers: {} });
        }
        openaiCalls += 1;
        assert.equal(JSON.parse(String(init?.body)).model, 'standard');
        return Response.json({ output_text: 'Fallback answer.' });
      },
    });
    assert.equal(response.status, 200);
    assert.equal(openaiCalls, 1);
    assert.equal(response.headers.get('X-Murmur-Decision'), 'fallback');
  }
});

test('cancelling Jev never starts an OpenAI fallback request', async () => {
  const controller = new AbortController();
  let calls = 0;
  const response = await handleExplorePost(request(input, controller.signal), { environment, fetchImpl: async () => {
    calls += 1;
    controller.abort();
    throw new DOMException('Cancelled', 'AbortError');
  } });
  assert.equal(response.status, 499);
  assert.equal(calls, 1);
});

test('incomplete, primitive, or empty OpenAI responses cannot appear as successful answers', async () => {
  for (const payload of [null, 'text', { status: 'incomplete', output_text: 'A cut-off sentence' }, { output: [] }]) {
    const response = await handleExplorePost(request(), {
      environment: { OPENAI_API_KEY: 'key' }, fetchImpl: async () => Response.json(payload),
    });
    assert.equal(response.status, 502);
  }
});
