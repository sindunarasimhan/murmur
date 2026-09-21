import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from './config';
import { Repository } from './repository';
import { createTranscriptionSession } from '../src/server/openai-realtime/provider';
import { MAX_VOICE_MS, VoiceInputBudget } from './voice-budget';

/** One utterance per socket. Clients cannot change the provider session or retain a credential. */
export class VoiceGateway {
  private sockets = new Map<string, WebSocket>();
  constructor(private readonly repository: Repository, private readonly config: BackendConfig) {}
  cancel(sessionId: string) { this.sockets.get(sessionId)?.close(1000, 'listening state changed'); }
  close() { for (const socket of this.sockets.values()) socket.close(1001, 'server closing'); }
  register(app: FastifyInstance) {
    app.get('/v2/voice', { websocket: true }, (socket, request) => {
      const protocol = request.headers['sec-websocket-protocol']?.split(',').map((item) => item.trim()).find((item) => item.startsWith('murmur-ticket.'));
      const token = protocol?.slice('murmur-ticket.'.length);
      let upstream: WebSocket | undefined;
      let sessionId: string | undefined;
      const budget = new VoiceInputBudget();
      let ready = false;
      let closed = false;
      const pending: string[] = [];
      const controller = new AbortController();
      const stop = () => {
        if (closed) return;
        closed = true; controller.abort(); clearTimeout(deadline); clearInterval(freshness);
        if (upstream?.readyState === WebSocket.CONNECTING) upstream.terminate(); else upstream?.close();
        if (sessionId && this.sockets.get(sessionId) === socket) this.sockets.delete(sessionId);
      };
      const fail = (message: string) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'error', error: { code: 'voice_unavailable', message } }));
        socket.close(1008, 'voice ended'); stop();
      };
      const deadline = setTimeout(() => fail('The voice window ended. Tap the microphone to try again.'), MAX_VOICE_MS);
      let checking = false;
      let revision: number | undefined;
      const freshness = setInterval(() => {
        if (!sessionId || checking || closed) return;
        checking = true;
        void this.repository.pool.query('SELECT revision FROM listening_sessions WHERE id=$1', [sessionId])
          .then((result) => { if (result.rows[0]?.revision !== revision) { socket.close(1000, 'session changed'); stop(); } })
          .catch(() => fail('Voice is unavailable right now.'))
          .finally(() => { checking = false; });
      }, 1000);
      socket.on('close', stop);
      socket.on('error', stop);
      socket.on('message', (raw, binary) => {
        if (closed) return;
        try {
          if (binary || !Buffer.isBuffer(raw) || raw.length > 128 * 1024) throw new Error();
          const normalized = budget.accept(JSON.parse(raw.toString()));
          if (ready) upstream!.send(normalized); else pending.push(normalized);
        } catch { fail('That voice request could not be read. Tap the microphone to try again.'); }
      });
      void (async () => {
        if (!token || !/^[\w-]{43}$/.test(token)) return fail('This voice connection has expired.');
        const ticket = await this.repository.consumeVoiceTicket(token);
        if (!ticket || closed) return fail('This voice connection has expired.');
        sessionId = ticket.sessionId; revision = ticket.revision;
        this.cancel(sessionId); this.sockets.set(sessionId, socket);
        const { openai } = this.config.providers;
        if (!openai.apiKey) return fail('Voice transcription is not configured yet.');
        const credential = await createTranscriptionSession('episode', { apiKey: openai.apiKey, model: openai.realtimeModel, signal: controller.signal });
        if (closed) return;
        upstream = new WebSocket('wss://api.openai.com/v1/realtime', { headers: { Authorization: `Bearer ${credential.clientSecret}` }, maxPayload: 256 * 1024, handshakeTimeout: 8000 });
        upstream.on('open', () => { ready = true; for (const event of pending.splice(0)) upstream!.send(event); });
        upstream.on('message', (raw) => {
          if (closed || socket.readyState !== WebSocket.OPEN) return;
          try {
            const event = JSON.parse(raw.toString());
            if (event.type === 'error') return fail('Transcription is unavailable right now. Your place is saved.');
            if (['conversation.item.input_audio_transcription.delta', 'conversation.item.input_audio_transcription.completed'].includes(event.type)) {
              socket.send(JSON.stringify({ type: event.type, item_id: event.item_id, delta: event.delta, transcript: event.transcript }));
            }
          } catch { fail('Transcription returned an unreadable response.'); }
        });
        upstream.on('error', () => fail('Transcription is unavailable right now. Your place is saved.'));
        upstream.on('close', () => { if (!closed) fail('Transcription ended. Tap the microphone to try again.'); });
      })().catch(() => { if (!closed) fail('Voice is unavailable right now. Your place is saved.'); });
    });
  }
}
