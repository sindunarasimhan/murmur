import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from './config';
import { Repository, hashToken } from './repository';
import { createTranscriptionSession } from '../src/server/openai-realtime/provider';

export const VOICE_LEASE_MS = 14 * 60_000;
/** A continuous connection allows bounded PCM; semantic sessions own their commits. */
export class ContinuousVoiceBudget {
  private total = 0;
  private buffered = 0;
  private frames = 0;
  constructor(private readonly started = Date.now(), private readonly semantic = false) {}
  accept(event: { type?: unknown; audio?: unknown }, now = Date.now()) {
    if (++this.frames > 30_000) throw new Error('Too many frames');
    if (event.type === 'input_audio_buffer.append' && typeof event.audio === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(event.audio)) {
      const audio = Buffer.from(event.audio, 'base64');
      if (!audio.length || audio.length % 2 || audio.toString('base64') !== event.audio) throw new Error('Invalid PCM');
      this.total += audio.length; this.buffered += audio.length;
      if (this.total > 48_000 * (VOICE_LEASE_MS / 1000 + 1) || this.total > 48_000 * ((now - this.started) / 1000 + 3) || (!this.semantic && this.buffered > 48_000 * 20)) throw new Error('Audio budget exceeded');
      return JSON.stringify({ type: event.type, audio: event.audio });
    }
    if (!this.semantic && event.type === 'input_audio_buffer.commit' && this.buffered >= 4800) {
      this.buffered = 0; return JSON.stringify({ type: event.type });
    }
    if (event.type === 'input_audio_buffer.clear') {
      this.buffered = 0; return JSON.stringify({ type: event.type });
    }
    throw new Error('Unsupported voice message');
  }
}

export class ContinuousVoiceGateway {
  private sockets = new Map<string, WebSocket>();
  constructor(private readonly repository: Repository, private readonly config: BackendConfig) {}
  async ticket(owner: string) {
    await this.repository.charge(owner);
    const token = randomBytes(32).toString('base64url');
    await this.repository.pool.query('DELETE FROM listening_voice_tickets WHERE owner_id=$1 OR expires_at<now()', [owner]);
    await this.repository.pool.query(`INSERT INTO listening_voice_tickets(token_hash,owner_id,expires_at) VALUES($1,$2,now()+interval '30 seconds')`, [hashToken(token), owner]);
    return { token, leaseMilliseconds: VOICE_LEASE_MS };
  }
  async consume(token: string): Promise<string | undefined> {
    const result = await this.repository.pool.query(`DELETE FROM listening_voice_tickets t USING identities i
      WHERE t.token_hash=$1 AND t.expires_at>now() AND i.id=t.owner_id AND i.expires_at>now() RETURNING t.owner_id`, [hashToken(token)]);
    return result.rows[0]?.owner_id;
  }
  cancel(owner: string) { this.sockets.get(owner)?.close(1000, 'voice stopped'); }
  close() { for (const socket of this.sockets.values()) socket.close(1001, 'server closing'); }
  register(app: FastifyInstance) {
    app.get('/v2/live-voice', { websocket: true }, (socket, request) => {
      const connection = randomBytes(4).toString('hex');
      const diagnostic = (event: string, details: Record<string, number | boolean | string> = {}) => {
        if (process.env.NODE_ENV !== 'production') console.info('[murmur-voice]', JSON.stringify({ connection, event, ...details }));
      };
      const protocols = request.headers['sec-websocket-protocol']?.split(',').map((x) => x.trim()) ?? [];
      const token = protocols.find((x) => x.startsWith('murmur-ticket.'))?.slice(14);
      const semantic = protocols.includes('murmur-semantic-v1');
      const budget = new ContinuousVoiceBudget(Date.now(), semantic);
      const controller = new AbortController();
      let upstream: WebSocket | undefined; let owner: string | undefined; let closed = false; let ready = false; let charging = false;
      let chargeTimer: ReturnType<typeof setInterval> | undefined;
      let receivedBytes = 0; let lastInputLog = 0;
      const stop = () => {
        if (closed) return; closed = true; controller.abort(); clearTimeout(deadline); clearInterval(chargeTimer);
        if (upstream?.readyState === WebSocket.CONNECTING) upstream.terminate(); else upstream?.close();
        if (owner && this.sockets.get(owner) === socket) this.sockets.delete(owner);
      };
      const fail = (message: string) => {
        diagnostic('failure', { message });
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'error', message }));
        socket.close(1008, 'voice unavailable'); stop();
      };
      const deadline = setTimeout(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'renew' })); socket.close(1000, 'renew voice lease'); stop(); }, VOICE_LEASE_MS);
      socket.on('close', (code) => { diagnostic('client-closed', { code }); stop(); }); socket.on('error', stop);
      socket.on('message', (data, binary) => {
        if (closed) return;
        try {
          if (!ready || binary || !Buffer.isBuffer(data) || data.length > 128 * 1024 || upstream!.bufferedAmount > 256 * 1024) throw new Error();
          const accepted = budget.accept(JSON.parse(data.toString()));
          receivedBytes += data.length;
          if (Date.now() - lastInputLog > 10_000) {
            lastInputLog = Date.now(); diagnostic('input', { receivedBytes });
          }
          upstream!.send(accepted);
        } catch { fail('The microphone connection was interrupted. Your place is saved.'); }
      });
      void (async () => {
        if (!token || !/^[\w-]{43}$/.test(token)) return fail('Your microphone connection has expired.');
        owner = await this.consume(token);
        if (!owner || closed) return fail('Your microphone connection has expired.');
        this.cancel(owner); this.sockets.set(owner, socket);
        const openai = this.config.providers.openai;
        if (!openai.apiKey) return fail('Voice is not configured.');
        const catalog = await this.repository.catalog();
        const credential = await createTranscriptionSession('episode', {
          apiKey: openai.apiKey, model: semantic ? this.config.semanticVoiceModel : openai.realtimeModel, signal: controller.signal,
          ...(semantic ? { turnDetection: 'semantic' as const } : {}),
          keywords: catalog.flatMap(({ showTitle, guest }) => guest ? [showTitle, guest] : [showTitle]),
        });
        if (closed) return;
        upstream = new WebSocket('wss://api.openai.com/v1/realtime', { headers: { Authorization: `Bearer ${credential.clientSecret}` }, handshakeTimeout: 8000, maxPayload: 256 * 1024 });
        const markReady = () => {
          if (closed || socket.readyState !== WebSocket.OPEN) return stop();
          if (ready) return;
          ready = true; socket.send(JSON.stringify({ type: 'ready', supportsAudioClear: true, turnDetection: semantic ? 'semantic' : 'client' }));
          diagnostic('ready', { semantic });
          // One quota unit per minute; a long wake-word stream cannot evade limits.
          chargeTimer = setInterval(() => {
            if (closed || charging) return; charging = true;
            void this.repository.charge(owner!).catch(() => fail('The daily voice allowance is used up. Your place is saved.')).finally(() => { charging = false; });
          }, 60_000);
        };
        upstream.on('open', () => { if (!semantic) markReady(); });
        upstream.on('message', (data) => {
          if (closed || socket.readyState !== WebSocket.OPEN) return;
          try {
            const event = JSON.parse(data.toString());
            if (semantic && event.type === 'session.created') {
              const detection = event.session?.audio?.input?.turn_detection;
              if (detection?.type !== 'semantic_vad' || detection.eagerness !== 'low') return fail('The requested voice turn detection is unavailable.');
              markReady();
            }
            if (event.type === 'error') {
              diagnostic('provider-error', { code: typeof event.error?.code === 'string' ? event.error.code.slice(0, 80) : 'unknown' });
              return fail('Voice transcription is temporarily unavailable.');
            }
            if (event.type === 'conversation.item.input_audio_transcription.completed') {
              diagnostic('transcript-final', { characters: typeof event.transcript === 'string' ? event.transcript.length : 0,
                wake: typeof event.transcript === 'string' && /\bhey[\s,.!?]+mur\s*mur\b/i.test(event.transcript) });
            }
            if (['input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped', 'input_audio_buffer.committed', 'input_audio_buffer.cleared', 'conversation.item.input_audio_transcription.delta', 'conversation.item.input_audio_transcription.completed'].includes(event.type)) {
              socket.send(JSON.stringify({ type: event.type, item_id: event.item_id, delta: event.delta, transcript: event.transcript }));
            }
          } catch { fail('The voice service returned an unreadable response.'); }
        });
        upstream.on('error', () => fail('Voice transcription is temporarily unavailable.'));
        upstream.on('close', () => { if (!closed) fail('The voice connection ended. Your place is saved.'); });
      })().catch(() => { if (!closed) fail('The voice connection could not start.'); });
    });
  }
}
