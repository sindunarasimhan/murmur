import type { CatalogResolution, ListeningSession, Observation, PreparedEpisode, TurnResult } from '../../../shared/listening';

export type VoicePhase = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'followup' | 'playing' | 'paused' | 'error';
export type VoiceState = { phase: VoicePhase; microphone: boolean; episode?: PreparedEpisode; caption: string; heard: string; error?: string };
export type ListeningPorts = {
  uuid(): string;
  audio: { position(): number; load(episode: PreparedEpisode, position: number, signal: AbortSignal): Promise<void>; play(): void; pause(): void; seek(seconds: number): Promise<number>; clear(): void };
  microphone: { start(): Promise<void>; stop(): Promise<void> };
  speech: { say(text: string, signal: AbortSignal, turn?: TurnResult): Promise<void>; stop(): Promise<void> };
  api: {
    resolve(utterance: string, episodeId: string | undefined, history: string[], signal: AbortSignal): Promise<CatalogResolution>;
    open(id: string): Promise<ListeningSession>;
    session(id: string): Promise<ListeningSession>;
    observe(session: ListeningSession, reason: Observation['reason'], seconds: number): Promise<ListeningSession>;
    turn(session: ListeningSession, text: string, seconds: number, id: string, signal: AbortSignal, resumeAfterAction?: boolean): Promise<TurnResult>;
    acknowledge(session: ListeningSession, id: string, seconds: number): Promise<ListeningSession>;
  };
  changed(state: VoiceState): void;
  followupMs?: number;
};

const WAKE = /\bhey[\s,]+(?:murmur|murmer|mur mur)\b[\s,.:!?-]*/i;
export function wakeRequest(text: string): string | undefined {
  const match = WAKE.exec(text);
  return match ? text.slice(match.index + match[0].length).trim() : undefined;
}

/** Owns the voice loop independently of rendering, microphone hardware, and providers. */
export class LennyVoiceController {
  state: VoiceState = { phase: 'idle', microphone: false, caption: 'A good conversation starts with listening.', heard: '' };
  private session?: ListeningSession;
  private epoch = 0;
  private abort = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private speakingDeadline?: ReturnType<typeof setTimeout>;
  private queue: Promise<unknown> = Promise.resolve();
  private item?: string;
  private wakeItem?: string;
  private itemModes = new Map<string, boolean>();
  private history: string[] = [];
  private disposed = false;
  private awaitingFinal = false;
  private resumeAfterConversation = false;
  constructor(private readonly ports: ListeningPorts) {}
  private update(patch: Partial<VoiceState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch }; this.ports.changed(this.state);
  }
  private current(epoch: number) { return !this.disposed && epoch === this.epoch; }
  private next() {
    this.abort.abort(); this.abort = new AbortController(); clearTimeout(this.timer); clearTimeout(this.speakingDeadline);
    this.speakingDeadline = undefined;
    this.awaitingFinal = false; return ++this.epoch;
  }
  private serialize<T>(work: () => Promise<T>) {
    const result = this.queue.catch(() => undefined).then(work); this.queue = result.catch(() => undefined); return result;
  }
  private async observe(reason: Observation['reason'], epoch: number) {
    const id = this.session?.id;
    if (!id) return;
    await this.serialize(async () => {
      const position = this.ports.audio.position();
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!this.current(epoch) || this.session?.id !== id) return;
        const fresh = await this.ports.api.session(id);
        if (!this.current(epoch)) return;
        try {
          const next = await this.ports.api.observe(fresh, reason, position);
          if (this.current(epoch)) this.session = next;
          return;
        } catch (error) {
          if (attempt || !(error instanceof Error) || !('code' in error) || error.code !== 'stale_session') throw error;
        }
      }
    });
  }
  async activate() {
    const epoch = this.next();
    this.ports.audio.pause(); await this.ports.speech.stop();
    if (!this.current(epoch)) return;
    this.update({ phase: 'connecting', error: undefined, heard: '', caption: 'Opening your microphone…' });
    try {
      await this.ports.microphone.stop();
      if (!this.current(epoch)) return;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.ports.microphone.start(), new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('The microphone did not open. Check microphone permission, then tap Hey Murmur again.')), 25_000);
        })]);
      } finally { clearTimeout(deadline); }
      // Capture adapters release their own cancelled generation. Stopping here
      // would shut down a newer activation after a late permission response.
      if (!this.current(epoch)) return;
      this.itemModes.clear(); this.item = undefined;
      this.update({ microphone: true, phase: 'listening', caption: 'Who or what would you like to hear?' });
      this.armSilence(epoch);
    } catch (error) { await this.fail(error, epoch); }
  }
  partial(text: string, item: string) {
    if (!this.state.microphone || this.disposed) return;
    const wake = wakeRequest(text);
    if (wake !== undefined && this.wakeItem !== item) {
      this.wakeItem = item; this.item = item; this.itemModes.set(item, true);
      const epoch = this.next();
      this.ports.audio.pause();
      this.update({ phase: 'listening', caption: 'I’m listening.', heard: wake, error: undefined });
      void this.ports.speech.stop();
      void this.observe('interrupt', epoch).catch((error) => this.fail(error, epoch));
      this.armSilence(epoch);
    }
    if (!this.itemModes.has(item)) this.itemModes.set(item, ['listening', 'followup'].includes(this.state.phase));
    if (this.itemModes.size > 64) this.itemModes.delete(this.itemModes.keys().next().value!);
    if (!this.itemModes.get(item) || !['listening', 'followup'].includes(this.state.phase)) return;
    this.item = item;
    this.update({ phase: 'listening', heard: (wake ?? text).slice(-1000) });
    this.armSilence(this.epoch);
  }
  final(text: string, item: string) {
    if (!this.state.microphone || this.disposed) return;
    if (/^(?:hey[ ,]+murmur[ ,.!?]*)?(?:please )?(?:stop listening|turn off (?:the )?(?:microphone|mic))[.!?]*$/i.test(text.trim())) {
      this.itemModes.set(item, false); void this.shutdown(true); return;
    }
    if (!this.itemModes.has(item)) this.partial(text, item);
    if (!this.itemModes.get(item) || this.item !== item || !['listening', 'followup'].includes(this.state.phase)) return;
    this.itemModes.set(item, false); this.item = undefined; this.awaitingFinal = false;
    const request = wakeRequest(text) ?? text.trim();
    if (!request) { this.armSilence(this.epoch); return; }
    void this.submit(request.slice(0, 1000));
  }
  activity() {
    if (!['listening', 'followup'].includes(this.state.phase)) return;
    // Don't return to the podcast while the user is speaking or while the final
    // transcription is in flight. A hard deadline bounds noise/stalled providers.
    clearTimeout(this.timer);
    this.awaitingFinal = true;
    if (!this.speakingDeadline) this.speakingDeadline = setTimeout(() => {
      this.speakingDeadline = undefined;
      if (this.awaitingFinal) void this.fail(new Error('I couldn’t hear a complete request. Your place is saved.'), this.epoch);
    }, 24_000);
  }
  private armSilence(epoch: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.current(epoch) || !['listening', 'followup'].includes(this.state.phase)) return;
      if (this.awaitingFinal) return;
      if (this.resumeAfterConversation && this.state.episode && this.ports.audio.position() < this.state.episode.durationSeconds - 1) void this.submit('back to the podcast', true);
      else this.update({ phase: this.state.episode ? 'paused' : 'idle', caption: 'Say “Hey Murmur” when you’re ready.' });
    }, this.ports.followupMs ?? 6000);
  }
  private async say(text: string, epoch: number, turn?: TurnResult) {
    if (!this.current(epoch)) return;
    this.update({ phase: 'speaking', caption: text });
    await this.ports.speech.say(text, this.abort.signal, turn);
  }
  async submit(text: string, returning = false) {
    const epoch = this.next();
    this.ports.audio.pause(); await this.ports.speech.stop();
    if (!this.current(epoch)) return;
    this.update({ phase: 'thinking', heard: text, caption: 'Following your thought…', error: undefined });
    try {
      const resolution = returning ? { kind: 'current' as const, message: '' }
        : await this.ports.api.resolve(text, this.state.episode?.id, this.history, this.abort.signal);
      if (!this.current(epoch)) return;
      if (resolution.kind === 'stop') { await this.shutdown(true); return; }
      if (resolution.kind === 'home') {
        await this.observe('cancel', epoch); if (!this.current(epoch)) return;
        this.ports.audio.clear(); this.session = undefined;
        this.update({ episode: undefined });
      }
      if (resolution.kind === 'play' && resolution.episode) {
        await this.observe('cancel', epoch); if (!this.current(epoch)) return;
        const episode = resolution.episode;
        let session = await this.ports.api.open(episode.id);
        if (!this.current(epoch)) return;
        const saved = session.bookmarkSeconds ?? session.positionSeconds;
        const position = saved >= episode.durationSeconds - 1 ? 0 : saved;
        session = await this.ports.api.observe(session, 'cancel', position);
        if (!this.current(epoch)) return;
        this.session = session; this.update({ episode });
        this.resumeAfterConversation = true;
        this.history = [];
        await this.ports.audio.load(episode, position, this.abort.signal);
        if (!this.current(epoch)) return;
        await this.say(resolution.message, epoch);
        if (!this.current(epoch)) return;
        await this.observe('play', epoch);
        if (!this.current(epoch)) return;
        this.ports.audio.play(); this.update({ phase: 'playing', caption: 'Say “Hey Murmur” to interrupt.', heard: '' }); return;
      }
      if (resolution.kind === 'current' && this.session) {
        await this.observe('interrupt', epoch);
        if (!this.current(epoch)) return;
        const turn = await this.ports.api.turn(this.session, text, this.ports.audio.position(), this.ports.uuid(), this.abort.signal, this.resumeAfterConversation);
        if (!this.current(epoch)) return;
        this.session = turn.session;
        if (turn.action) {
          this.resumeAfterConversation = turn.action.play;
          const action = turn.action;
          await this.serialize(async () => {
            if (!this.current(epoch)) return;
            const actual = action.kind === 'pause' ? this.ports.audio.position() : await this.ports.audio.seek(action.positionSeconds);
            // A device seek cannot always be cancelled. Persist its actual
            // result before any newer interruption reads its bookmark.
            const next = await this.ports.api.acknowledge(turn.session, action.id, actual);
            if (this.current(epoch)) this.session = next;
          });
          if (!this.current(epoch)) return;
          await this.say(action.kind === 'skip-ad' ? action.play ? 'Ad skipped. Back to Lenny.' : 'Ad skipped. Still paused.'
            : action.play ? action.kind === 'seek' ? 'Picking up here.' : 'Back to Lenny.' : action.kind === 'seek' ? 'Moved there. Still paused.' : 'Paused.', epoch);
          if (!this.current(epoch)) return;
          if (turn.action.play) this.ports.audio.play();
          this.update({ phase: turn.action.play ? 'playing' : 'paused', caption: 'Say “Hey Murmur” whenever you need me.', heard: '' }); return;
        }
        await this.say(turn.answer, epoch, turn.followUp === false || turn.decision === 'code' ? undefined : turn);
        if (!this.current(epoch)) return;
        await this.observe('speech-ended', epoch);
        if (!this.current(epoch)) return;
        if (turn.followUp === false) {
          if (this.resumeAfterConversation) await this.submit('back to the podcast', true);
          else this.update({ phase: 'paused', caption: 'Still paused. Say “Hey Murmur, resume” when you’re ready.', heard: '' });
          return;
        }
      } else {
        this.history = [...this.history, text, resolution.message].slice(-4);
        await this.say(resolution.message, epoch);
      }
      if (!this.current(epoch)) return;
      this.awaitingFinal = false;
      this.update({ phase: 'followup', caption: 'Anything else?', heard: '' }); this.armSilence(epoch);
    } catch (error) { await this.fail(error, epoch); }
  }
  async progress() {
    if (this.state.phase !== 'playing') return;
    const epoch = this.epoch;
    try { await this.observe('progress', epoch); } catch (error) { await this.fail(error, epoch); }
  }
  async ended() {
    if (this.state.phase !== 'playing') return;
    const epoch = this.next();
    this.resumeAfterConversation = false;
    try {
      await this.observe('pause', epoch);
      await this.say('That’s the end of the episode. What would you like to hear next?', epoch);
      if (this.current(epoch)) { this.update({ phase: 'followup' }); this.armSilence(epoch); }
    } catch (error) { await this.fail(error, epoch); }
  }
  async shutdown(announce = false) {
    const epoch = this.next();
    this.update({ microphone: false, phase: 'idle' }); this.ports.audio.pause();
    await Promise.all([this.ports.microphone.stop(), this.ports.speech.stop()]);
    if (!this.current(epoch)) return;
    await this.observe('cancel', epoch).catch(() => undefined);
    if (!this.current(epoch)) return;
    this.ports.audio.clear(); this.session = undefined; this.item = undefined; this.itemModes.clear();
    this.resumeAfterConversation = false;
    this.update({ episode: undefined, heard: '', caption: 'Your place is saved. Tap Hey Murmur to begin.' });
    if (announce) {
      await this.say('Microphone off. Your place is saved.', epoch);
      if (this.current(epoch)) this.update({ phase: 'idle' });
    }
  }
  async fail(error: unknown, epoch = this.epoch) {
    if (!this.current(epoch)) return;
    const message = error instanceof Error ? error.message : 'Murmur could not finish that request. Your place is saved.';
    await this.shutdown();
    if (!this.current(epoch + 1)) return;
    this.update({ phase: 'error', caption: message, error: message });
    await this.ports.speech.say(message, this.abort.signal).catch(() => undefined);
  }
  async dispose() {
    this.disposed = true; this.next(); this.ports.audio.pause();
    await Promise.all([this.ports.microphone.stop(), this.ports.speech.stop()]);
  }
}
