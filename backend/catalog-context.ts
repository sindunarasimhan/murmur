import type { Pool } from 'pg';
import { ConversationContexts, emptyContext, type ConversationContext } from './conversation-context';
import { emptyDiscovery, type DiscoveryState } from './catalog-discovery';

// A client conversation ID replaces brittle matching of the last spoken pair.
// Revision reservations reject stale/cancelled writers across server processes.
export class CatalogContexts {
  constructor(private readonly pool: Pool, private readonly contexts: ConversationContexts) {}
  async begin(owner: string, id: string, episodeId: string | undefined, history: string[], signal: AbortSignal) {
    signal.throwIfAborted();
    const result = await this.pool.query(`INSERT INTO catalog_conversations(owner_id,id,episode_id,context,discovery)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,id) DO UPDATE SET revision=catalog_conversations.revision+1,
      context=CASE WHEN catalog_conversations.episode_id IS NOT DISTINCT FROM EXCLUDED.episode_id THEN catalog_conversations.context ELSE EXCLUDED.context END,
      discovery=CASE WHEN catalog_conversations.episode_id IS NOT DISTINCT FROM EXCLUDED.episode_id THEN catalog_conversations.discovery ELSE EXCLUDED.discovery END,
      episode_id=EXCLUDED.episode_id,updated_at=now() RETURNING revision,context,discovery`,
    [owner, id, episodeId ?? null, JSON.stringify(emptyContext()), JSON.stringify(emptyDiscovery())]);
    const row = result.rows[0];
    let context: ConversationContext = row.context;
    if (row.revision === 0) {
      for (let index = 0; index + 1 < history.length; index += 2) context = await this.contexts.append(context,
        { question: history[index]!, answer: history[index + 1]! }, signal);
    }
    const assertCurrent = async (abort: AbortSignal) => {
      abort.throwIfAborted();
      const current = await this.pool.query('SELECT 1 FROM catalog_conversations WHERE owner_id=$1 AND id=$2 AND revision=$3', [owner, id, row.revision]);
      if (!current.rowCount) throw new DOMException('Superseded catalog request', 'AbortError');
      abort.throwIfAborted();
    };
    return {
      state: row.discovery as DiscoveryState, memory: context.memory,
      history: context.recent.flatMap((turn) => [turn.question, turn.answer]), assertCurrent,
      commit: async (utterance: string, message: string, state: DiscoveryState, abort: AbortSignal) => {
        const next = await this.contexts.append(context, { question: utterance, answer: message }, abort);
        abort.throwIfAborted();
        const updated = await this.pool.query(`UPDATE catalog_conversations SET context=$4,discovery=$5,updated_at=now()
          WHERE owner_id=$1 AND id=$2 AND revision=$3`, [owner, id, row.revision, JSON.stringify(next), JSON.stringify(state)]);
        if (!updated.rowCount) throw new DOMException('Superseded catalog request', 'AbortError');
      },
      clear: async (abort: AbortSignal) => {
        await assertCurrent(abort);
        // Keep the revision tombstone: deleting/recreating revision zero would
        // let an old in-flight request become current again (the ABA race).
        const updated = await this.pool.query(`UPDATE catalog_conversations SET revision=revision+1,context=$4,discovery=$5,updated_at=now()
          WHERE owner_id=$1 AND id=$2 AND revision=$3`, [owner, id, row.revision, JSON.stringify(emptyContext()), JSON.stringify(emptyDiscovery())]);
        if (!updated.rowCount) throw new DOMException('Superseded catalog request', 'AbortError');
      },
    };
  }
}
