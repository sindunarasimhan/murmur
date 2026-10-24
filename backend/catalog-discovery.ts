// Process-local conversation memory, bounded and isolated by listener. Client
// history acknowledges a received reply; a mismatch starts fresh discovery.
export type DiscoveryState = {
  intent: string;
  preferences: { value: string; basis: 'explicit' | 'tentative' }[];
  unknowns: string[];
  rejectedEpisodeIds: string[];
  offeredEpisodeIds: string[];
  pendingOffers: { option: number; episodeId: string; label?: string }[];
  lastQuestion: string | null;
  discoveryQuestions: number;
  questionLimit: 1 | 2;
};
export const emptyDiscovery = (): DiscoveryState => ({
  intent: '', preferences: [], unknowns: [], rejectedEpisodeIds: [],
  offeredEpisodeIds: [], pendingOffers: [], lastQuestion: null,
  discoveryQuestions: 0, questionLimit: 2,
});

// The model's dialogue must end with the request being interpreted. Otherwise
// a previous user turn (for example withholding playback) can look like the
// latest instruction even though utterance contains a newer request.
export const catalogDialogue = (history: string[], utterance: string) => [
  ...history.map((text, index) => ({ role: index % 2 ? 'assistant' : 'user', text })),
  { role: 'user', text: utterance },
];
type Entry = { token: object; touched: number; episodeId?: string; history: string[]; state: DiscoveryState };

export class CatalogDiscoveryMemory {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly now = Date.now, private readonly ttlMs = 30 * 60_000, private readonly capacity = 1000) {}

  forget(owner: string) { this.entries.delete(owner); }

  begin(owner: string, episodeId: string | undefined, history: string[]) {
    const now = this.now();
    for (const [key, entry] of this.entries) if (now - entry.touched >= this.ttlMs) this.entries.delete(key);
    const previous = this.entries.get(owner);
    const lastPair = previous?.history.slice(-2) ?? [];
    const acknowledgedAt = lastPair.length === 2 ? history.findIndex((text, index) =>
      index % 2 === 0 && text === lastPair[0] && history[index + 1] === lastPair[1]) : -1;
    const continued = previous?.episodeId === episodeId && acknowledgedAt >= 0;
    const entry: Entry = {
      token: {}, touched: now, episodeId,
      state: continued ? structuredClone(previous!.state) : emptyDiscovery(),
      history: continued ? [...previous!.history, ...history.slice(acknowledgedAt + 2)].slice(-16) : history.slice(-16),
    };
    this.entries.delete(owner);
    while (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(owner, entry);
    const assertCurrent = (signal: AbortSignal) => {
      signal.throwIfAborted();
      if (this.entries.get(owner)?.token !== entry.token) throw new DOMException('Superseded catalog request', 'AbortError');
    };
    return {
      memory: undefined,
      state: structuredClone(entry.state), history: [...entry.history], assertCurrent,
      commit: (utterance: string, message: string, state: DiscoveryState, signal: AbortSignal) => {
        assertCurrent(signal);
        entry.state = structuredClone(state);
        entry.history = [...entry.history, utterance, message].slice(-16);
        entry.touched = this.now();
      },
      clear: (signal: AbortSignal) => { assertCurrent(signal); this.entries.delete(owner); },
    };
  }
}
