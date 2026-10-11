import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { backendConfig } from './config';
import { createDatabase, migrate } from './database';
import { Repository } from './repository';
import { ListeningService } from './listening-service';
import { exactCommand, type Intelligence } from './intelligence';
import { actionSchema } from '../shared/listening';
import { prepareStoredAdPlan } from './ad-preparation-store';

test('new action requires complete assignment while legacy actions remain compatible', () => {
  const action = { id: randomUUID(), kind: 'set-ad-skipping', positionSeconds: 0, play: true };
  assert.equal(actionSchema.safeParse(action).success, false);
  assert.equal(actionSchema.safeParse({ ...action, kind: 'pause' }).success, true);
});

test('episode ad metadata drives shared one-off and auto skipping without changing recording or transcript', { timeout: 30_000 }, async () => {
  const config = backendConfig();
  const admin = createDatabase(config.databaseUrl);
  const database = `murmur_ads_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${database}`);
  const url = new URL(config.databaseUrl); url.pathname = `/${database}`;
  const pool = createDatabase(url.toString());
  try {
    await migrate(pool);
    const repo = new Repository(pool, { dailyUserCalls: 0, dailyProjectCalls: 0 });
    const owner = await repo.createIdentity('test');
    const version = 'a'.repeat(64);
    await pool.query(`INSERT INTO episodes(id,title,show_title,description,audio_version,duration_seconds,status,audio_url)
      VALUES('test','Test','Test','Test',$1,600,'ready','https://example.com/original.mp3')`, [version]);
    for (const [id, start, end, text] of [['one', 0, 100, 'Welcome'], ['ad', 100, 130, 'Sponsored commercial'], ['talk', 130, 300, 'Interview'], ['ad2', 300, 340, 'Commercial'], ['end', 340, 600, 'Interview ending']]) {
      await pool.query('INSERT INTO transcript_segments(episode_id,audio_version,id,start_seconds,end_seconds,text) VALUES(\'test\',$1,$2,$3,$4,$5)', [version, id, start, end, text]);
    }
    const before = await repo.episode('test');
    const transcripts = await pool.query('SELECT * FROM transcript_segments ORDER BY id');
    let session = await repo.openSession(owner.id, 'test');
    const plan = await prepareStoredAdPlan(pool, 'test', async (passages) => passages.map((passage) => ({ id: passage.id, classification: passage.id.startsWith('ad') ? 'advertisement' : 'content', probability: 0.99 })), { persist: true });
    assert.deepEqual(await repo.episode('test'), before);
    assert.deepEqual((await pool.query('SELECT * FROM transcript_segments ORDER BY id')).rows, transcripts.rows);
    assert.deepEqual(await repo.session(owner.id, session.id), session);
    assert.equal(plan.intervals.length, 2);
    const intelligence: Intelligence = {
      decide: async ({ utterance }) => utterance === 'enable' ? { kind: 'set-ad-skipping', enabled: true, source: 'jev' }
        : utterance === 'disable' ? { kind: 'set-ad-skipping', enabled: false, source: 'jev' }
          : exactCommand(utterance) ?? { kind: 'unclear', source: 'jev' },
      answer: async () => 'Answer',
    };
    const service = new ListeningService(repo, intelligence);
    const interrupt = async (position: number) => { session = await repo.observe(owner.id, session.id, { revision: session.revision, audioVersion: version, positionSeconds: position, reason: 'interrupt' }); };
    const turn = async (utterance: string, resume: boolean) => {
      const result = await service.turn(owner.id, session.id, { revision: session.revision, audioVersion: version, positionSeconds: session.positionSeconds, requestId: randomUUID(), utterance, resumeAfterAction: resume });
      session = result.session;
      return result;
    };
    const ack = async (result: Awaited<ReturnType<typeof turn>>) => {
      assert(result.action);
      const input = { revision: session.revision, audioVersion: version, actionId: result.action.id, positionSeconds: result.action.positionSeconds };
      session = await repo.acknowledge(owner.id, session.id, input);
      if (result.action.kind === 'set-ad-skipping') {
        assert.deepEqual(await repo.acknowledge(owner.id, session.id, input), session);
        await assert.rejects(repo.acknowledge(owner.id, session.id, { ...input, positionSeconds: input.positionSeconds + 1 }));
      }
    };
    for (const playing of [true, false]) {
      await interrupt(110);
      const enabled = await turn('enable', playing);
      assert.equal(enabled.action?.kind, 'set-ad-skipping');
      assert.equal(enabled.action?.positionSeconds, 130);
      assert.equal(enabled.action?.play, playing);
      assert.equal(enabled.action?.plan?.audioVersion, version);
      await ack(enabled);
      assert.equal(session.adSkipping, true);
      assert.equal(session.positionSeconds, 130);
      await interrupt(140);
      const seek = await turn('go to five minutes', playing);
      assert.equal(seek.action?.positionSeconds, 340);
      await ack(seek);
      await interrupt(340);
      const disabled = await turn('disable', playing);
      assert.equal(disabled.action?.positionSeconds, 340);
      await ack(disabled);
      assert.equal(session.adSkipping, false);
      await interrupt(110);
      const oneOff = await turn('skip ad', playing);
      assert.equal(oneOff.action?.positionSeconds, 130);
      assert.equal(oneOff.action?.play, playing);
      await ack(oneOff);
    }
    await interrupt(150);
    await ack(await turn('enable', true));
    session = await repo.openSession(owner.id, 'test');
    assert.equal(session.adSkipping, false);
    assert.equal(session.positionSeconds, 150);
    await interrupt(150);
    const abandoned = await turn('enable', true);
    const abandonedInput = { revision: session.revision, audioVersion: version, actionId: abandoned.action!.id, positionSeconds: abandoned.action!.positionSeconds };
    session = await repo.openSession(owner.id, 'test');
    assert.equal(session.pendingAction, null);
    await assert.rejects(repo.acknowledge(owner.id, session.id, abandonedInput));
    assert.deepEqual(await repo.episode('test'), before);
    assert.deepEqual((await pool.query('SELECT * FROM transcript_segments ORDER BY id')).rows, transcripts.rows);
    await assert.rejects(prepareStoredAdPlan(pool, 'test', async (passages) => {
      await pool.query('UPDATE episodes SET ad_plan=NULL WHERE id=\'test\'');
      return passages.map((passage) => ({ id: passage.id, classification: 'content', probability: 0.99 }));
    }, { persist: true }), /changed during preparation/);
    await interrupt(150);
    const unavailable = await turn('enable', true);
    assert.equal(unavailable.action, null);
    assert.equal(unavailable.session.positionSeconds, 150);
    assert.equal(unavailable.session.adSkipping, false);
    service.close();
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  }
});
