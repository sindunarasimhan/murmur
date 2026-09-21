import { bytesToBase64, normalizePcm16, type WebSocketLike } from './realtime-transcription';

export type VoiceCallbacks = {
  partial(text: string, item: string): void;
  final(text: string, item: string): void;
  activity(): void;
  error(error: Error): void;
};
/** Streaming text stays local and ephemeral unless it becomes a listener command. */
export class ContinuousTranscription {
  private socket?: WebSocketLike;
  private closed = true;
  private ready = false;
  private generation = 0;
  private texts = new Map<string, string>();
  private bytes = 0;
  private voiced = false;
  private silenceAt = 0;
  private startedAt = 0;
  private renewal?: ReturnType<typeof setTimeout>;
  private abort?: AbortController;
  private cancelConnect?: () => void;
  constructor(private readonly options: {
    url: () => string;
    ticket: (signal: AbortSignal) => Promise<{ token: string; leaseMilliseconds: number }>;
    callbacks: VoiceCallbacks;
    socket?: (url: string, protocols: string[]) => WebSocketLike;
  }) {}
  async start() {
    this.closed = false;
    const generation = ++this.generation;
    this.abort = new AbortController();
    const ticket = await this.options.ticket(this.abort.signal);
    if (this.closed || generation !== this.generation) return;
    const socket = (this.options.socket ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketLike))(this.options.url(), [`murmur-ticket.${ticket.token}`]);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      this.cancelConnect = () => { clearTimeout(timer); if (!settled) { settled = true; reject(new Error('Microphone connection cancelled')); } };
      const timer = setTimeout(() => fail(new Error('The microphone connection took too long.')), 15_000);
      const fail = (error: Error) => {
        clearTimeout(timer);
        if (generation !== this.generation || this.closed) { if (!settled) reject(error); return; }
        if (!settled) { settled = true; reject(error); }
        else this.options.callbacks.error(error);
        this.stop();
      };
      socket.onopen = () => {};
      socket.onerror = () => fail(new Error('The microphone connection was interrupted.'));
      socket.onclose = () => fail(new Error('The microphone connection ended. Your place is saved.'));
      socket.onmessage = ({ data }) => {
        if (typeof data !== 'string' || this.closed || generation !== this.generation) return;
        let event: { type: string; item_id?: string; delta?: string; transcript?: string; message?: string };
        try { event = JSON.parse(data); } catch { return fail(new Error('Voice returned an unreadable response.')); }
        if (event.type === 'ready') {
          this.ready = true; settled = true; clearTimeout(timer); this.resetBuffer(); resolve();
          this.renewal = setTimeout(() => { void this.renew().catch((error: Error) => this.options.callbacks.error(error)); }, ticket.leaseMilliseconds - 10_000);
        } else if (event.type === 'error') fail(new Error(event.message ?? 'Voice is temporarily unavailable.'));
        else if (event.type === 'renew') { void this.renew().catch((error: Error) => this.options.callbacks.error(error)); }
        else if (event.item_id && event.type.endsWith('.delta') && typeof event.delta === 'string') {
          const text = `${this.texts.get(event.item_id) ?? ''}${event.delta}`.slice(-6000);
          this.texts.set(event.item_id, text);
          this.options.callbacks.partial(text, event.item_id);
        } else if (event.item_id && event.type.endsWith('.completed') && typeof event.transcript === 'string') {
          this.texts.delete(event.item_id);
          this.options.callbacks.final(event.transcript.trim(), event.item_id);
        }
        if (this.texts.size > 32) this.texts.delete(this.texts.keys().next().value!);
      };
    });
  }
  private async renew() {
    if (this.closed) return;
    this.stop(); await this.start();
  }
  private resetBuffer() { this.bytes = 0; this.voiced = false; this.silenceAt = 0; this.startedAt = Date.now(); }
  append(data: ArrayBuffer, sampleRate: number, channels: number) {
    if (!this.ready || this.socket?.readyState !== 1 || this.closed) return;
    const pcm = normalizePcm16(data, sampleRate, channels, 24_000);
    if (!pcm.length) return;
    this.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: bytesToBase64(pcm) }));
    this.bytes += pcm.length;
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
    let energy = 0;
    for (let i = 0; i < samples.length; i += 8) energy += ((samples[i] ?? 0) / 32768) ** 2;
    const loud = Math.sqrt(energy / Math.ceil(samples.length / 8)) > 0.008;
    const now = Date.now();
    if (loud) { this.voiced = true; this.silenceAt = 0; this.options.callbacks.activity(); }
    else if (this.voiced) this.silenceAt ||= now;
    // Bound monitoring text without waiting for the podcast itself to go silent.
    if ((this.silenceAt && now - this.silenceAt >= 900) || now - this.startedAt > 8000 || this.bytes >= 48_000 * 12) this.commit();
  }
  commit() {
    if (this.ready && this.socket?.readyState === 1 && this.bytes >= 4800) {
      this.socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' })); this.resetBuffer();
    }
  }
  stop() {
    this.closed = true; this.ready = false; this.generation++; clearTimeout(this.renewal); this.abort?.abort();
    this.cancelConnect?.(); this.cancelConnect = undefined;
    const socket = this.socket; this.socket = undefined;
    if (socket) { socket.onmessage = null; socket.onerror = null; socket.onclose = null; socket.close(1000, 'microphone off'); }
    this.texts.clear(); this.resetBuffer();
  }
}
