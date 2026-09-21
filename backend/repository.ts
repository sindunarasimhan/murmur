import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { sessionSchema, type ListeningSession, type Observation, type TurnRequest, type TurnResult, type PreparedEpisode, type Evidence } from '../shared/listening';
import { transaction } from './database';
import { ServiceError, missing, stale } from './errors';
import { resolveAd, type AdResolution } from './ad-policy';

const sessionColumns = `id, episode_id AS "episodeId", audio_version AS "audioVersion", revision,
  position_seconds AS "positionSeconds", bookmark_seconds AS "bookmarkSeconds", phase,
  pending_action AS "pendingAction"`;
export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');

export class Repository {
  constructor(readonly pool: Pool, private readonly limits: { dailyUserCalls: number; dailyProjectCalls: number; focusEpisodeId?: string | null }) {}

  private async bucket(client: PoolClient, scope: string, limit: number) {
    const result = await client.query(`INSERT INTO usage_buckets(scope,calls) VALUES($1,1)
      ON CONFLICT(scope,day) DO UPDATE SET calls=usage_buckets.calls+1 WHERE usage_buckets.calls < $2 RETURNING calls`, [scope, limit]);
    if (!result.rowCount) throw new ServiceError(429, 'daily_limit', 'The daily testing allowance has been reached. Please try again tomorrow.');
  }
  async charge(owner: string, client?: PoolClient) {
    const reserve = async (db: PoolClient) => {
      await this.bucket(db, 'project:provider', this.limits.dailyProjectCalls);
      await this.bucket(db, `identity:${owner}`, this.limits.dailyUserCalls);
    };
    return client ? reserve(client) : transaction(this.pool, reserve);
  }
  async createIdentity(ip: string) {
    return transaction(this.pool, async (client) => {
      await this.bucket(client, `signup:${hashToken(ip)}`, 20);
      const id = randomUUID();
      const token = randomBytes(32).toString('base64url');
      await client.query('INSERT INTO identities(id,token_hash) VALUES($1,$2)', [id, hashToken(token)]);
      return { id, token };
    });
  }
  async identity(token: string | undefined): Promise<string | undefined> {
    if (!token || !/^[\w-]{43}$/.test(token)) return undefined;
    const result = await this.pool.query('SELECT id FROM identities WHERE token_hash=$1 AND expires_at>now()', [hashToken(token)]);
    return result.rows[0]?.id;
  }
  async deleteIdentity(owner: string) {
    await this.pool.query('DELETE FROM identities WHERE id=$1', [owner]);
  }
  async episode(id = 'small-places'): Promise<PreparedEpisode> {
    const result = await this.pool.query(`SELECT id,title,show_title AS "showTitle",description,
      audio_version AS "audioVersion",duration_seconds AS "durationSeconds",status,
      CASE WHEN status='ready' THEN COALESCE(audio_url, '/media/' || audio_key) ELSE NULL END AS "audioPath",
      guest,published_at::text AS "publishedAt",source_url AS "sourceUrl",artwork_url AS "artworkUrl",
      (status='ready') AS "transcriptReady" FROM episodes WHERE id=$1`, [id]);
    if (!result.rows[0]) throw new ServiceError(503, 'preparing', 'The first episode is being prepared. Please try again shortly.');
    return result.rows[0];
  }
  async catalog(): Promise<PreparedEpisode[]> {
    const ids = await this.pool.query(`SELECT id FROM episodes WHERE collection='lenny-free' AND status='ready' AND ($1::text IS NULL OR id=$1) ORDER BY published_at DESC,id`, [this.limits.focusEpisodeId ?? null]);
    return Promise.all(ids.rows.map((row) => this.episode(row.id)));
  }
  async unfinished(owner: string): Promise<PreparedEpisode | undefined> {
    const rows = await this.pool.query(`SELECT e.id FROM listening_sessions s JOIN episodes e ON e.id=s.episode_id
      WHERE s.owner_id=$1 AND e.collection='lenny-free' AND e.status='ready' AND s.position_seconds>0 AND s.position_seconds<e.duration_seconds-20
      AND ($2::text IS NULL OR e.id=$2) ORDER BY s.updated_at DESC LIMIT 1`, [owner, this.limits.focusEpisodeId ?? null]);
    return rows.rows[0] ? this.episode(rows.rows[0].id) : undefined;
  }
  async currentAd(session: ListeningSession): Promise<AdResolution> {
    const result = await this.pool.query('SELECT ad_breaks,audio_key,duration_seconds FROM episodes WHERE id=$1 AND audio_version=$2', [session.episodeId, session.audioVersion]);
    const position = session.bookmarkSeconds ?? session.positionSeconds;
    const episode = result.rows[0];
    return episode ? resolveAd(position, episode.duration_seconds, session.audioVersion, episode.ad_breaks, episode.audio_key) : { kind: 'unverified' };
  }
  async openSession(owner: string, episodeId: string): Promise<ListeningSession> {
    const result = await this.pool.query(`INSERT INTO listening_sessions(id,owner_id,episode_id,audio_version)
      SELECT $1,$2,id,audio_version FROM episodes WHERE id=$3 AND status='ready'
      ON CONFLICT(owner_id,episode_id) DO UPDATE SET updated_at=now(),
        audio_version=EXCLUDED.audio_version,
        position_seconds=CASE WHEN listening_sessions.audio_version=EXCLUDED.audio_version THEN listening_sessions.position_seconds ELSE 0 END,
        bookmark_seconds=CASE WHEN listening_sessions.audio_version=EXCLUDED.audio_version THEN listening_sessions.bookmark_seconds ELSE NULL END,
        revision=listening_sessions.revision+CASE WHEN listening_sessions.audio_version=EXCLUDED.audio_version THEN 0 ELSE 1 END,
        phase=CASE WHEN listening_sessions.audio_version=EXCLUDED.audio_version THEN listening_sessions.phase ELSE 'paused' END,
        pending_action=CASE WHEN listening_sessions.audio_version=EXCLUDED.audio_version THEN listening_sessions.pending_action ELSE NULL END
      RETURNING ${sessionColumns}`, [randomUUID(), owner, episodeId]);
    if (!result.rows[0]) throw new ServiceError(409, 'preparing', 'This episode is still being prepared.');
    return sessionSchema.parse(result.rows[0]);
  }
  async session(owner: string, id: string, client?: PoolClient, lock = false): Promise<ListeningSession> {
    const result = await (client ?? this.pool).query(`SELECT ${sessionColumns} FROM listening_sessions
      WHERE id=$1 AND owner_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [id, owner]);
    if (!result.rows[0]) throw missing();
    return sessionSchema.parse(result.rows[0]);
  }
  private async validateSnapshot(client: PoolClient, session: ListeningSession, input: { revision: number; audioVersion: string; positionSeconds: number }) {
    if (session.revision !== input.revision || session.audioVersion !== input.audioVersion) throw stale();
    const episode = await client.query('SELECT duration_seconds,audio_version FROM episodes WHERE id=$1', [session.episodeId]);
    if (episode.rows[0]?.audio_version !== input.audioVersion || input.positionSeconds > episode.rows[0].duration_seconds + 0.5) throw stale();
  }
  async observe(owner: string, id: string, input: Observation): Promise<ListeningSession> {
    return transaction(this.pool, async (client) => {
      const session = await this.session(owner, id, client, true);
      await this.validateSnapshot(client, session, input);
      if (input.reason === 'progress' && !['playing', 'paused'].includes(session.phase)) throw stale();
      const keepBookmark = ['interrupt', 'speech-ended', 'cancel'].includes(input.reason);
      const bookmark = input.reason === 'interrupt' ? session.bookmarkSeconds ?? input.positionSeconds : keepBookmark ? session.bookmarkSeconds : null;
      const phase = input.reason === 'interrupt' ? 'listening' : input.reason === 'speech-ended' ? 'exploring'
        : input.reason === 'play' ? 'playing' : input.reason === 'progress' ? session.phase : 'paused';
      await client.query(`UPDATE conversation_turns SET status='cancelled' WHERE session_id=$1 AND status='processing'`, [id]);
      const result = await client.query(`UPDATE listening_sessions SET revision=revision+1,position_seconds=$2,
        bookmark_seconds=$3,phase=$4,pending_action=NULL,updated_at=now() WHERE id=$1 RETURNING ${sessionColumns}`,
      [id, input.positionSeconds, bookmark, phase]);
      return sessionSchema.parse(result.rows[0]);
    });
  }
  async reserveTurn(owner: string, id: string, input: TurnRequest): Promise<{ session: ListeningSession; cached?: TurnResult }> {
    return transaction(this.pool, async (client) => {
      const session = await this.session(owner, id, client, true);
      const fingerprint = hashToken(JSON.stringify(input));
      const prior = await client.query('SELECT request_hash,status,result FROM conversation_turns WHERE session_id=$1 AND request_id=$2', [id, input.requestId]);
      if (prior.rows[0]) {
        const row = prior.rows[0];
        if (row.request_hash !== fingerprint) throw new ServiceError(409, 'request_reused', 'This request identifier was already used.');
        if (row.status === 'complete' && row.result.session.revision === session.revision) return { session, cached: row.result };
        throw new ServiceError(409, 'request_already_handled', 'This request was already handled. Refresh the session before continuing.');
      }
      await this.validateSnapshot(client, session, input);
      await this.charge(owner, client);
      await client.query(`UPDATE conversation_turns SET status='cancelled' WHERE session_id=$1 AND status='processing'`, [id]);
      await client.query(`INSERT INTO conversation_turns(session_id,request_id,request_hash,question,status) VALUES($1,$2,$3,$4,'processing')`, [id, input.requestId, fingerprint, input.utterance]);
      const updated = await client.query(`UPDATE listening_sessions SET revision=revision+1,position_seconds=$2,
        bookmark_seconds=COALESCE(bookmark_seconds,$2),phase='resolving',pending_action=NULL,updated_at=now()
        WHERE id=$1 RETURNING ${sessionColumns}`, [id, input.positionSeconds]);
      return { session: sessionSchema.parse(updated.rows[0]) };
    });
  }
  async completeTurn(owner: string, session: ListeningSession, requestId: string, output: Omit<TurnResult, 'requestId' | 'session'>) {
    return transaction(this.pool, async (client) => {
      const current = await this.session(owner, session.id, client, true);
      if (current.revision !== session.revision) throw stale();
      await this.validateSnapshot(client, current, session);
      const result = await client.query(`UPDATE listening_sessions SET revision=revision+1,phase=$2,pending_action=$3,updated_at=now()
        WHERE id=$1 RETURNING ${sessionColumns}`, [session.id, output.action ? 'paused' : 'speaking', JSON.stringify(output.action)]);
      const turn: TurnResult = { ...output, requestId, session: sessionSchema.parse(result.rows[0]) };
      await client.query(`UPDATE conversation_turns SET status='complete',result=$3 WHERE session_id=$1 AND request_id=$2`, [session.id, requestId, JSON.stringify(turn)]);
      return turn;
    });
  }
  async failTurn(session: ListeningSession, requestId: string, code: string) {
    await transaction(this.pool, async (client) => {
      await client.query('SELECT id FROM listening_sessions WHERE id=$1 FOR UPDATE', [session.id]);
      await client.query(`UPDATE conversation_turns SET status='failed',error_code=$3 WHERE session_id=$1 AND request_id=$2 AND status='processing'`, [session.id, requestId, code]);
      await client.query(`UPDATE listening_sessions SET phase='exploring',revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$2`, [session.id, session.revision]);
    });
  }
  async acknowledge(owner: string, id: string, input: { revision: number; audioVersion: string; actionId: string; positionSeconds: number }) {
    return transaction(this.pool, async (client) => {
      const session = await this.session(owner, id, client, true);
      await this.validateSnapshot(client, session, input);
      const action = session.pendingAction;
      const tolerance = action?.kind === 'skip-ad' ? 0.25 : 1;
      if (!action || action.id !== input.actionId || Math.abs(action.positionSeconds - input.positionSeconds) > tolerance || action.kind === 'skip-ad' && input.positionSeconds < action.positionSeconds - 0.05) throw stale();
      const result = await client.query(`UPDATE listening_sessions SET revision=revision+1,position_seconds=$2,bookmark_seconds=NULL,
        phase=$3,pending_action=NULL,updated_at=now() WHERE id=$1 RETURNING ${sessionColumns}`, [id, input.positionSeconds, action.play ? 'playing' : 'paused']);
      return sessionSchema.parse(result.rows[0]);
    });
  }
  async evidence(session: ListeningSession, question: string): Promise<Evidence[]> {
    // Spoken questions contain conversational filler. Match any significant
    // lexeme so "jump to the discussion about pricing" can retrieve pricing
    // far from the bookmark without requiring every command word in a passage.
    const search = (question.match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => word.length > 2).slice(0, 64).join(' OR ');
    const result = await this.pool.query(`SELECT id,start_seconds AS "startSeconds",end_seconds AS "endSeconds",text
      FROM transcript_segments WHERE episode_id=$1 AND audio_version=$2 ORDER BY
      CASE WHEN start_seconds <= $3 AND end_seconds >= $3 THEN 0 ELSE 1 END,
      ts_rank(search,websearch_to_tsquery('english',$4)) DESC, abs(start_seconds-$3) LIMIT 8`,
    [session.episodeId, session.audioVersion, session.bookmarkSeconds ?? session.positionSeconds, search]);
    return result.rows;
  }
  async history(sessionId: string): Promise<{ question: string; answer: string }[]> {
    const result = await this.pool.query(`SELECT t.question,t.result->>'answer' AS answer FROM conversation_turns t
      JOIN listening_sessions s ON s.id=t.session_id AND t.result#>>'{session,audioVersion}'=s.audio_version
      WHERE t.session_id=$1 AND t.status='complete' AND t.result->>'answer' <> '' ORDER BY t.created_at DESC LIMIT 5`, [sessionId]);
    return result.rows.reverse();
  }
  async voiceTicket(owner: string, id: string) {
    return transaction(this.pool, async (client) => {
      const session = await this.session(owner, id, client, true);
      if (session.phase !== 'listening') throw stale();
      await this.charge(owner, client);
      const token = randomBytes(32).toString('base64url');
      await client.query('DELETE FROM voice_tickets WHERE session_id=$1 OR expires_at<now()', [id]);
      await client.query(`INSERT INTO voice_tickets(token_hash,session_id,revision,expires_at) VALUES($1,$2,$3,now()+interval '30 seconds')`, [hashToken(token), id, session.revision]);
      return token;
    });
  }
  async consumeVoiceTicket(token: string): Promise<{ sessionId: string; revision: number } | undefined> {
    const result = await this.pool.query(`DELETE FROM voice_tickets t USING listening_sessions s
      WHERE t.token_hash=$1 AND t.expires_at>now() AND s.id=t.session_id AND s.revision=t.revision AND s.phase='listening'
      RETURNING t.session_id AS "sessionId",t.revision`, [hashToken(token)]);
    return result.rows[0];
  }
}
