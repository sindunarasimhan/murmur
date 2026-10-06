import type { CatalogResolution, ListeningSession, Observation, PreparedEpisode, TurnResult } from '../../../shared/listening';

export type VoicePhase = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'followup' | 'playing' | 'paused' | 'error';
type Engagement = 'wake-required' | 'catalog-dialogue' | 'episode-dialogue';
type Utterance = { kind: 'pending'; epoch: number; order: number; finalText?: string } | { kind: 'ambient' } | { kind: 'consumed' };
export type VoiceState = { phase: VoicePhase; microphone: boolean; speechPlaying?: boolean; speechLevel?: number; episode?: PreparedEpisode; caption: string; heard: string; error?: string };
export type ListeningPorts = {
  uuid(): string;
  audio: { position(): number; playing(): boolean; load(episode: PreparedEpisode, position: number, signal: AbortSignal): Promise<void>; play(): void; pause(): void; seek(seconds: number): Promise<number>; clear(): void };
  microphone: { start(onStage: (caption: string) => void): Promise<void>; stop(): Promise<void> };
  speech: { say(text: string, signal: AbortSignal, turn?: TurnResult): Promise<void>; stop(): Promise<void> };
  api: {
    invite(history: string[], signal: AbortSignal): Promise<string>;
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
  private utterances = new Map<string, Utterance>();
  private utteranceOrder = 0;
  private displayedOrder = 0;
  private recentSpeech?: { text: string; expires: number };
  private history: string[] = [];
  private disposed = false;
  private awaitingFinal = false;
  private resumeAfterConversation = false;
  private engagement: Engagement = 'wake-required';
  private background = false;
  private needsPlaybackSync = false;
  private inviting = false;
  private remember(question: string, answer: string) {
    this.history = [...this.history, question.slice(0, 1000), answer.slice(0, 1000)].slice(-4);
  }
  constructor(private readonly ports: ListeningPorts) {}
  private update(patch: Partial<VoiceState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch }; this.ports.changed(this.state);
  }
  private current(epoch: number) { return !this.disposed && epoch === this.epoch; }
  private next() {
    this.inviting = false;
    this.update({ speechPlaying: false, speechLevel: 0 });
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
    this.background = false;
    const epoch = this.next();
    this.update({ phase: 'connecting', error: undefined, heard: '', caption: 'Opening your microphone…' });
    await this.ports.speech.stop();
    if (!this.current(epoch)) return;
    try {
      await this.ports.microphone.stop();
      if (!this.current(epoch)) return;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([this.ports.microphone.start((caption) => {
          if (this.current(epoch)) this.update({ caption });
        }), new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('The microphone did not open. Check microphone permission and your connection, then reopen Murmur.')), 25_000);
        })]);
      } finally { clearTimeout(deadline); }
      // Capture adapters release their own cancelled generation. Stopping here
      // would shut down a newer activation after a late permission response.
      if (!this.current(epoch)) return;
      this.resetUtterances();
      if (this.state.episode) {
        this.resumeAfterConversation = this.ports.audio.playing();
        this.needsPlaybackSync = true;
        this.update({ microphone: true, phase: this.resumeAfterConversation ? 'playing' : 'paused', caption: 'Say “Hey Murmur” whenever you need me.' });
      } else {
        this.update({ microphone: true, phase: 'listening', caption: 'Who or what would you like to hear?' });
        this.armSilence(epoch);
      }
    } catch (error) { await this.fail(error, epoch); }
  }
  private resetUtterances() {
    for (const id of this.utterances.keys()) this.utterances.set(id, { kind: 'consumed' });
    this.item = undefined; this.wakeItem = undefined; this.recentSpeech = undefined;
  }
  private recordUtterance(id: string, value: Utterance) {
    this.utterances.set(id, value);
    if (this.utterances.size > 64) this.utterances.delete(this.utterances.keys().next().value!);
  }
  private finishInput() {
    this.awaitingFinal = false;
    clearTimeout(this.speakingDeadline); this.speakingDeadline = undefined;
  }
  private receive(text: string, item: string, final: boolean): string | undefined {
    if (!this.state.microphone || this.disposed) return;
    const known = this.utterances.get(item);
    if (known?.kind === 'consumed') return;
    if (!text.trim()) {
      if (final) {
        this.recordUtterance(item, { kind: 'consumed' });
        if (!this.item || this.item === item) { this.item = undefined; this.finishInput(); this.armSilence(this.epoch); }
      }
      return;
    }
    const normalized = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
    const echo = this.recentSpeech && Date.now() <= this.recentSpeech.expires && normalized(text) === normalized(this.recentSpeech.text);
    if (echo) {
      if (final) {
        this.recordUtterance(item, { kind: 'consumed' });
        if (!this.item || this.item === item) { this.item = undefined; this.finishInput(); this.armSilence(this.epoch); }
      }
      return;
    }
    const wake = wakeRequest(text);
    if (known?.kind === 'pending' && known.epoch !== this.epoch) {
      this.recordUtterance(item, { kind: 'consumed' }); return;
    }
    if (this.inviting && this.state.phase === 'thinking' && wake === undefined && text.trim()) {
      this.inviting = false;
      this.next();
      this.update({ phase: 'listening' });
    }
    if (wake !== undefined && this.wakeItem !== item) {
      this.wakeItem = item; this.item = item;
      const epoch = this.next();
      this.recordUtterance(item, { kind: 'pending', epoch, order: ++this.utteranceOrder });
      if (this.state.episode) this.engagement = 'episode-dialogue';
      this.ports.audio.pause();
      this.update({ phase: 'listening', caption: 'I’m listening.', heard: text.slice(-1000), error: undefined });
      void this.ports.speech.stop();
      void this.observe('interrupt', epoch).catch((error) => this.fail(error, epoch));
      this.armSilence(epoch);
    }
    if (!this.utterances.has(item)) this.recordUtterance(item,
      ['listening', 'followup', 'speaking'].includes(this.state.phase) ? { kind: 'pending', epoch: this.epoch, order: ++this.utteranceOrder } : { kind: 'ambient' });
    const utterance = this.utterances.get(item);
    if (utterance?.kind === 'pending' && this.state.phase === 'speaking' && final) {
      this.recordUtterance(item, { ...utterance, finalText: text }); return;
    }
    if (utterance?.kind !== 'pending' || utterance.order < this.displayedOrder || !['listening', 'followup'].includes(this.state.phase)) {
      if (final) this.recordUtterance(item, { kind: 'consumed' });
      return;
    }
    this.item = item;
    this.displayedOrder = utterance.order;
    this.update({ phase: 'listening', heard: text.slice(-1000) });
    if (final) this.armSilence(this.epoch);
    else this.activity();
    if (final) { this.recordUtterance(item, { kind: 'consumed' }); this.item = undefined; this.finishInput(); }
    return wake ?? text.trim();
  }
  partial(text: string, item: string) {
    this.receive(text, item, false);
  }
  private followup(caption: string, epoch: number) {
    this.update({ phase: 'followup', caption });
    this.armSilence(epoch);
    const pending = [...this.utterances.entries()].reverse().find(([, value]) => value.kind === 'pending' && value.epoch === epoch);
    if (pending?.[1].kind === 'pending' && pending[1].finalText) this.final(pending[1].finalText, pending[0]);
  }
  final(text: string, item: string) {
    if (!this.state.microphone || this.disposed) return;
    if (this.utterances.get(item)?.kind === 'consumed') return;
    if (/^(?:hey[ ,]+murmur[ ,.!?]*)?(?:please )?(?:stop listening|turn off (?:the )?(?:microphone|mic))[.!?]*$/i.test(text.trim())) {
      this.recordUtterance(item, { kind: 'consumed' }); void this.shutdown(true); return;
    }
    const request = this.receive(text, item, true);
    if (request === undefined) return;
    if (!request) {
      if (!this.state.episode) void this.invite();
      else this.armSilence(this.epoch);
      return;
    }
    void this.submit(request.slice(0, 1000), false, text.slice(-1000));
  }
  private async invite() {
    const epoch = this.next();
    this.inviting = true;
    this.engagement = 'catalog-dialogue';
    this.update({ phase: 'thinking', caption: '' });
    try {
      const message = await this.ports.api.invite(this.history, this.abort.signal);
      if (!this.current(epoch)) return;
      this.remember('Hey Murmur', message);
      await this.say(message, epoch);
      if (!this.current(epoch)) return;
      this.followup('Listening', epoch);
    } catch (error) { await this.fail(error, epoch); }
    finally { if (this.current(epoch)) this.inviting = false; }
  }
  activity() {
    if (!['listening', 'followup'].includes(this.state.phase)) return;
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
      if (this.engagement !== 'wake-required') {
        this.update({ phase: 'followup', caption: 'Listening' });
        return;
      }
      this.update({ phase: this.state.episode ? 'paused' : 'idle', caption: 'Say “Hey Murmur” when you’re ready.' });
    }, this.ports.followupMs ?? 6000);
  }
  speechActivity(playing: boolean) {
    this.update({ speechPlaying: playing, speechLevel: 0 });
  }
  speechEnergy(level: number) {
    if (this.state.speechPlaying) this.update({ speechLevel: level });
  }
  private async say(text: string, epoch: number, turn?: TurnResult) {
    if (!this.current(epoch)) return;
    const reference = { text, expires: Number.POSITIVE_INFINITY };
    this.recentSpeech = reference;
    this.update({ phase: 'speaking', speechPlaying: false, caption: text });
    try { await this.ports.speech.say(text, this.abort.signal, turn); }
    finally { reference.expires = Date.now() + 12_000; }
  }
  async submit(text: string, returning = false, display = text) {
    if (this.background || this.disposed) return;
    const epoch = this.next();
    this.update({ phase: 'thinking', heard: display, caption: 'Following your thought…', error: undefined });
    this.ports.audio.pause(); await this.ports.speech.stop();
    if (!this.current(epoch)) return;
    try {
      if (this.needsPlaybackSync) {
        await this.observe(this.resumeAfterConversation ? 'play' : 'pause', epoch);
        if (!this.current(epoch)) return;
        this.needsPlaybackSync = false;
      }
      const resolution = returning ? { kind: 'current' as const, message: '' }
        : await this.ports.api.resolve(text, this.state.episode?.id, this.history, this.abort.signal);
      if (!this.current(epoch)) return;
      if (resolution.kind === 'stop') { await this.shutdown(true); return; }
      if (resolution.kind === 'home') {
        await this.observe('cancel', epoch); if (!this.current(epoch)) return;
        this.ports.audio.clear(); this.session = undefined;
        this.engagement = 'wake-required'; this.history = [];
        this.update({ episode: undefined });
      }
      if (resolution.kind === 'play' && resolution.episode) {
        this.engagement = 'wake-required';
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
          this.engagement = 'wake-required';
          this.history = [];
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
            : action.kind === 'skip-intro' ? action.play ? 'Here’s the conversation.' : 'Intro skipped. Still paused.'
            : action.play ? action.kind === 'seek' ? 'Picking up here.' : 'Back to Lenny.' : action.kind === 'seek' ? 'Moved there. Still paused.' : 'Paused.', epoch);
          if (!this.current(epoch)) return;
          if (turn.action.play) this.ports.audio.play();
          this.update({ phase: turn.action.play ? 'playing' : 'paused', caption: 'Say “Hey Murmur” whenever you need me.', heard: '' }); return;
        }
        if (turn.followUp !== false) {
          this.engagement = 'episode-dialogue';
          this.remember(text, turn.answer);
        }
        await this.say(turn.answer, epoch, turn.followUp === false || turn.decision === 'code' ? undefined : turn);
        if (!this.current(epoch)) return;
        await this.observe('speech-ended', epoch);
        if (!this.current(epoch)) return;
        if (turn.followUp === false) {
          this.engagement = 'wake-required';
          if (this.resumeAfterConversation) await this.submit('back to the podcast', true);
          else this.update({ phase: 'paused', caption: 'Still paused. Say “Hey Murmur, resume” when you’re ready.', heard: '' });
          return;
        }
      } else {
        this.engagement = resolution.kind === 'clarify' ? 'catalog-dialogue' : 'wake-required';
        this.remember(text, resolution.message);
        await this.say(resolution.message, epoch);
      }
      if (!this.current(epoch)) return;
      this.awaitingFinal = false;
      this.followup('Anything else?', epoch);
    } catch (error) { await this.fail(error, epoch); }
  }
  async progress() {
    if (this.background || this.state.phase !== 'playing') return;
    const epoch = this.epoch;
    try {
      await this.observe(this.needsPlaybackSync ? 'play' : 'progress', epoch);
      if (this.current(epoch)) this.needsPlaybackSync = false;
    } catch (error) { await this.fail(error, epoch); }
  }
  async ended() {
    if (this.background || !this.state.microphone) {
      this.resumeAfterConversation = false;
      this.needsPlaybackSync = true;
      this.update({ phase: 'paused' });
      return;
    }
    if (!this.state.episode || !['playing', 'paused'].includes(this.state.phase)) return;
    const epoch = this.next();
    this.resumeAfterConversation = false;
    this.engagement = 'catalog-dialogue';
    try {
      await this.observe('pause', epoch);
      await this.say('That’s the end of the episode. What would you like to hear next?', epoch);
      if (this.current(epoch)) { this.update({ phase: 'followup' }); this.armSilence(epoch); }
    } catch (error) { await this.fail(error, epoch); }
  }
  playbackChanged(playing: boolean) {
    if (!this.state.episode || !['playing', 'paused'].includes(this.state.phase)) return;
    this.resumeAfterConversation = playing;
    this.needsPlaybackSync = true;
    this.update({ phase: playing ? 'playing' : 'paused' });
  }
  async suspendVoice() {
    this.background = true;
    const epoch = this.next();
    this.needsPlaybackSync = true;
    this.engagement = 'wake-required';
    this.resetUtterances();
    this.update({ microphone: false, heard: '', phase: this.state.episode ? this.ports.audio.playing() ? 'playing' : 'paused' : 'idle', caption: '' });
    await Promise.all([this.ports.microphone.stop(), this.ports.speech.stop()]);
    if (!this.current(epoch)) return;
    this.resumeAfterConversation = this.ports.audio.playing();
    this.update({ phase: this.state.episode ? this.resumeAfterConversation ? 'playing' : 'paused' : 'idle' });
  }
  async shutdown(announce = false) {
    const epoch = this.next();
    this.engagement = 'wake-required'; this.history = [];
    this.update({ microphone: false, phase: 'idle' }); this.ports.audio.pause();
    await Promise.all([this.ports.microphone.stop(), this.ports.speech.stop()]);
    if (!this.current(epoch)) return;
    await this.observe('cancel', epoch).catch(() => undefined);
    if (!this.current(epoch)) return;
    this.ports.audio.clear(); this.session = undefined; this.resetUtterances();
    this.resumeAfterConversation = false;
    this.update({ episode: undefined, heard: '', caption: 'Microphone off. Your place is saved. Reopen Murmur to listen again.' });
    if (announce) {
      await this.say('Microphone off. Your place is saved.', epoch);
      if (this.current(epoch)) this.update({ phase: 'idle' });
    }
  }
  async fail(error: unknown, epoch = this.epoch) {
    if (!this.current(epoch)) return;
    let message = error instanceof Error ? error.message : 'Murmur could not finish that request. Your place is saved.';
    if (this.state.episode) {
      const background = this.background;
      try { await this.suspendVoice(); }
      catch { message += ' Voice cleanup failed. Reopen Murmur to retry.'; }
      if (!this.current(epoch + 1)) return;
      this.background = background;
      this.update({ error: message, caption: message });
      return;
    }
    try { await this.shutdown(); }
    catch { message += ' Audio cleanup also failed. Close and reopen Murmur.'; }
    if (!this.current(epoch + 1)) return;
    this.update({ phase: 'error', caption: message, error: message });
    await this.ports.speech.say(message, this.abort.signal).catch(() => undefined);
  }
  async dispose() {
    this.disposed = true; this.next();
    await Promise.allSettled([
      Promise.resolve().then(() => this.ports.audio.pause()),
      Promise.resolve().then(() => this.ports.microphone.stop()),
      Promise.resolve().then(() => this.ports.speech.stop()),
    ]);
  }
}
