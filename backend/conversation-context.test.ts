import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { ConversationContexts, emptyContext, contextSize, RECENT_CONTEXT_BUDGET, MEMORY_BUDGET, createContextCompactor, type ContextCompactor } from './conversation-context';
import { CatalogContexts } from './catalog-context';
import { CatalogService } from './catalog-service';
import { emptyDiscovery } from './catalog-discovery';
import { Repository } from './repository';
import { ListeningService } from './listening-service';
import { backendConfig } from './config';
import { createDatabase, migrate } from './database';
import type { Intelligence } from './intelligence';
import type { ListeningSession } from '../shared/listening';

const signal = () => new AbortController().signal;

test('compaction retains recent turns, carries prior memory forward, validates IDs and has a hard size bound', async () => {
  let calls = 0;
  const contexts = new ConversationContexts(async ({ memory, exchanges }) => {
    if (calls++ === 0) assert.equal(exchanges[0]!.question, 'Earlier preference');
    else assert.equal(memory.preferences[0]?.value, 'No business advice');
    return { ...memory, topic: 'Orbital science', preferences: [{ value: 'No business advice', basis: 'explicit' }],
      evidenceIds: ['grounded', 'invented'] };
  });
  let context = emptyContext();
  for (let i = 0; i < 60; i++) {
    context = await contexts.append(context, { question: i === 0 ? 'Earlier preference' : `Turn ${i}`, answer: 'Detail '.repeat(100), evidenceIds: ['grounded'] }, signal());
    assert(contextSize(context.recent) <= RECENT_CONTEXT_BUDGET);
    assert(JSON.stringify(context.memory).length <= MEMORY_BUDGET);
    assert.equal(context.recent.at(-1)?.question, i === 0 ? 'Earlier preference' : `Turn ${i}`);
  }
  assert(calls > 5);
  assert.deepEqual(context.memory.evidenceIds, ['grounded']);
  assert(!context.recent.some((turn) => turn.question === 'Earlier preference'));
  assert.equal(context.memory.preferences[0]?.value, 'No business advice');
});

test('failed, malformed and cancelled compaction never mutate or silently evict committed context', async () => {
  const context = emptyContext();
  context.recent = [{ question: 'Original preference', answer: 'x'.repeat(5000) }];
  const original = structuredClone(context);
  const failure = new ConversationContexts(async () => { throw new Error('provider down'); });
  await assert.rejects(failure.append(context, { question: 'Next', answer: 'y'.repeat(1500) }, signal()), /provider down/);
  assert.deepEqual(context, original);
  const malformed = new ConversationContexts(async () => ({ ...emptyContext().memory, topic: 'x'.repeat(301) }));
  await assert.rejects(malformed.append(context, { question: 'Next', answer: 'y'.repeat(1500) }, signal()));
  assert.deepEqual(context, original);
  const controller = new AbortController();
  const cancelled = new ConversationContexts(async () => { controller.abort(); return emptyContext().memory; });
  await assert.rejects(cancelled.append(context, { question: 'Next', answer: 'y'.repeat(1500) }, controller.signal), { name: 'AbortError' });
  assert.deepEqual(context, original);
});

test('OpenAI compactor uses bounded structured output and never accepts truncated provider output', async () => {
  const provider = { ...backendConfig().providers.openai, apiKey: 'test-only' };
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    assert.equal(body.text.format.type, 'json_schema');
    assert.match(body.instructions, /newer explicit user statements supersede/i);
    assert.match(body.instructions, /assistant suggestion is not a user decision/i);
    return new Response(JSON.stringify({ status: 'incomplete', output_text: JSON.stringify(emptyContext().memory) }));
  };
  await assert.rejects(createContextCompactor(provider, fetchImpl)({ memory: emptyContext().memory, exchanges: [] }, signal()));
});

test('durable catalog and episode contexts survive long detours, restarts, corrections and stale writers', { timeout: 60_000 }, async (t) => {
  const config = backendConfig();
  const admin = createDatabase(config.databaseUrl);
  const name = `murmur_context_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(config.databaseUrl); url.pathname = `/${name}`;
  const pool = createDatabase(url.toString());
  try {
    await migrate(pool); await migrate(pool);
    const repo = new Repository(pool, { dailyUserCalls: 0, dailyProjectCalls: 0 });
    const owner = await repo.createIdentity('context-test');
    const other = await repo.createIdentity('context-other');
    const version = 'a'.repeat(64);
    await pool.query(`INSERT INTO episodes(id,title,show_title,description,audio_version,duration_seconds,status,audio_url)
      VALUES('context-test','Orbital tradeoffs','Science','Orbital systems and mission economics',$1,3600,'ready','https://example.com/audio.mp3')`, [version]);
    for (let i = 0; i < 20; i++) await pool.query(`INSERT INTO transcript_segments(episode_id,audio_version,id,start_seconds,end_seconds,text)
      VALUES('context-test',$1,$2,$3,$4,$5)`, [version, `p${i}`, i * 100, (i + 1) * 100, i === 12 ? 'The orbital tradeoff is cost versus resilience.' : `Grounded passage ${i} about systems and their costs.`]);
    let compactions = 0;
    // Deterministic fixture compressor. Tests validate lifecycle and inputs;
    // model quality is checked separately, never inferred from this fake.
    const compact: ContextCompactor = async ({ memory, exchanges }) => {
      compactions++;
      const next = structuredClone(memory);
      for (const turn of exchanges) {
        if (turn.question === 'I prefer science, no business advice') next.preferences = [{ value: 'Science; exclude business advice', basis: 'explicit' }];
        if (turn.question === 'Correction: focus on mission economics, still no business advice') next.preferences = [{ value: 'Mission economics; exclude business advice', basis: 'explicit' }];
        if (turn.question === 'Explain the orbital tradeoff') next.threads = [{ topic: 'Orbital tradeoff', summary: 'Cost versus resilience; original question grounded in p12.' }];
        next.topic = turn.question;
      }
      next.evidenceIds = [...new Set([...next.evidenceIds, ...exchanges.flatMap((turn) => turn.evidenceIds ?? [])])].slice(-24);
      return next;
    };
    const contexts = new ConversationContexts(compact);
    const durable = () => new CatalogContexts(pool, contexts);
    await t.test('catalog preserves older preferences and ordered offers across more than two exchanges and service restarts', async () => {
      const id = randomUUID();
      for (let i = 0; i < 22; i++) {
        const service = new CatalogService(repo, async (input) => {
          if (i > 8) assert.match(JSON.stringify(input.memory), /exclude business advice/);
          if (i > 16) assert.match(JSON.stringify({ memory: input.memory, history: input.history }), /mission economics/i);
          if (i === 21) {
            assert.equal(input.discovery?.pendingOffers[0]?.episodeId, 'context-test');
            return { kind: 'select', episodeId: 'context-test' };
          }
          return { kind: 'clarify', candidateIds: ['context-test'], fallback: {
            message: `Reply ${i}: ` + 'A relevant topic for consideration. '.repeat(20), candidateIds: ['context-test'],
            discovery: { ...emptyDiscovery(), pendingOffers: [{ option: 1, episodeId: 'context-test' }] },
          } };
        }, undefined, durable());
        const question = i === 0 ? 'I prefer science, no business advice' : i === 10 ? 'Correction: focus on mission economics, still no business advice' : i === 21 ? 'Play the one we discussed' : `Detour ${i}`;
        // Even an empty acknowledgement tail cannot erase identified memory.
        const result = await service.resolve(owner.id, question, undefined, [], signal(), id);
        assert.equal(result.kind, i === 21 ? 'play' : 'clarify');
      }
      assert(compactions > 2);
      const closed = (await pool.query('SELECT context,revision FROM catalog_conversations WHERE owner_id=$1 AND id=$2', [owner.id, id])).rows[0];
      assert.deepEqual(closed.context, emptyContext()); assert(closed.revision > 21);
    });
    await t.test('catalog cancellation and revision races preserve committed memory and isolate listeners', async () => {
      const id = randomUUID();
      const first = await durable().begin(owner.id, id, undefined, [], signal());
      await first.commit('Keep this preference', 'Saved', { ...emptyDiscovery(), intent: 'Original' }, signal());
      const old = await durable().begin(owner.id, id, undefined, [], signal());
      const latest = await durable().begin(owner.id, id, undefined, [], signal());
      await latest.commit('New direction', 'Updated', { ...emptyDiscovery(), intent: 'New' }, signal());
      await assert.rejects(old.commit('Stale', 'Do not save', emptyDiscovery(), signal()), { name: 'AbortError' });
      const controller = new AbortController(); controller.abort();
      await assert.rejects(latest.commit('Cancelled', 'Do not save', emptyDiscovery(), controller.signal), { name: 'AbortError' });
      const restored = await durable().begin(owner.id, id, undefined, [], signal());
      assert.equal(restored.state.intent, 'New'); assert(restored.history.includes('Keep this preference'));
      const isolated = await durable().begin(other.id, id, undefined, [], signal()); assert.equal(isolated.history.length, 0);
      const scoped = await durable().begin(owner.id, id, 'context-test', [], signal()); assert.equal(scoped.history.length, 0);
    });
    let session = await repo.openSession(owner.id, 'context-test');
    const observe = async (reason: 'interrupt' | 'speech-ended' | 'play', position = 247.375) => {
      session = await repo.observe(owner.id, session.id, { revision: session.revision, audioVersion: version, positionSeconds: position, reason });
    };
    await observe('interrupt');
    await t.test('episode question, deep detour, pronoun and earlier topic retain anchor and grounded evidence beyond five QAs', async () => {
      let step = 0;
      const intelligence: Intelligence = {
        decide: async (input) => {
          assert.equal(input.session.bookmarkSeconds, 247.375);
          if (step > 8) {
            assert.match(JSON.stringify(input.memory), /Orbital tradeoff/);
            assert(input.evidence.some((item) => item.id === 'p12'));
          }
          return { kind: 'deeper', source: 'jev', passageId: step === 0 || step === 16 ? 'p12' : 'p2' };
        },
        answer: async (input) => {
          if (step === 16) { assert.match(JSON.stringify(input.memory), /Cost versus resilience/); assert.equal(input.evidence[0]?.id, 'p12'); }
          return 'Grounded analysis. '.repeat(40);
        },
      };
      for (step = 0; step < 18; step++) {
        const service = new ListeningService(new Repository(pool, { dailyUserCalls: 0, dailyProjectCalls: 0 }), intelligence, contexts);
        const result = await service.turn(owner.id, session.id, { requestId: randomUUID(), revision: session.revision, audioVersion: version,
          positionSeconds: 247.375, utterance: step === 0 ? 'Explain the orbital tradeoff' : step === 16 ? 'Back to the original tradeoff, why does it matter?' : `How does that affect implication ${step}?`, resumeAfterAction: false });
        assert.equal(result.action, null); session = result.session;
        await observe('speech-ended');
      }
      const saved = await repo.conversationContext(session);
      assert(saved); assert(contextSize(saved.recent) <= RECENT_CONTEXT_BUDGET);
      assert.match(JSON.stringify(saved.memory), /Orbital tradeoff/);
      const catalog = new CatalogService(repo, async (input) => {
        assert.match(JSON.stringify(input.discussion?.context.memory), /Orbital tradeoff/);
        assert.equal(input.discussion?.bookmarkSeconds, 247.375);
        return { kind: 'current' };
      }, undefined, durable());
      assert.equal((await catalog.resolve(owner.id, 'How does that compare to the first idea?', 'context-test', [], signal(), randomUUID())).kind, 'current');
    });
    await t.test('explicit return keeps the bookmark and future discussion memory survives a new playback position', async () => {
      const service = new ListeningService(repo, { decide: async () => ({ kind: 'return', source: 'jev' }), answer: async () => '' }, contexts);
      const result = await service.turn(owner.id, session.id, { requestId: randomUUID(), revision: session.revision, audioVersion: version, positionSeconds: 247.375, utterance: 'Return to podcast' });
      assert.equal(result.action?.positionSeconds, 247.375); assert.equal(result.action?.play, true);
      session = await repo.acknowledge(owner.id, session.id, { revision: result.session.revision, audioVersion: version, actionId: result.action!.id, positionSeconds: 247.375 });
      await observe('interrupt', 800);
      assert.match(JSON.stringify(await repo.conversationContext(session)), /Orbital tradeoff/);
      assert.equal(session.bookmarkSeconds, 800);
    });
    await t.test('stale turn completion cannot overwrite memory; changed audio and identity deletion remove scope', async () => {
      const original = await repo.conversationContext(session);
      const staleSession: ListeningSession = { ...session };
      await observe('speech-ended', 800);
      await assert.rejects(repo.completeTurn(owner.id, staleSession, randomUUID(), { answer: 'Stale', action: null, decision: 'jev', evidence: [], followUp: true }, emptyContext()));
      assert.deepEqual(await repo.conversationContext(session), original);
      await pool.query("UPDATE episodes SET audio_version=$1 WHERE id='context-test'", ['b'.repeat(64)]);
      session = await repo.openSession(owner.id, 'context-test');
      assert.equal(await repo.conversationContext(session), undefined);
      await repo.deleteIdentity(owner.id);
      assert.equal((await pool.query('SELECT 1 FROM catalog_conversations WHERE owner_id=$1', [owner.id])).rowCount, 0);
    });
  } finally {
    await pool.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end();
  }
});
