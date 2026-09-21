import { SERVER_BUDGETS } from '../config';
import { isRecord, readUpstreamJson, requestUpstream, UpstreamError } from '../http/upstream';
import { REALTIME_SAMPLE_RATE, type RealtimeSurface, type RealtimeTokenResponse } from './contracts';

export async function createTranscriptionSession(surface: RealtimeSurface, options: {
  apiKey: string; model: string; fetch?: typeof fetch; signal: AbortSignal;
}): Promise<RealtimeTokenResponse> {
  return requestUpstream('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session: {
        type: 'transcription',
        audio: { input: {
          format: { type: 'audio/pcm', rate: REALTIME_SAMPLE_RATE },
          noise_reduction: { type: 'near_field' },
          transcription: {
            model: options.model, delay: 'minimal', languages: ['en'],
            prompt: surface === 'episode'
              ? 'A listener controlling a podcast or asking a question about the current episode. Transcribe the wake phrase Hey Murmur exactly when spoken. Common requests include skip ad, pause, play, go back, and explain that.'
              : 'A listener choosing a podcast episode by speaking its title, show name, host, or topic.',
          },
          // gpt-live-transcribe relies on the client's silence detector to commit.
          turn_detection: null,
        } },
      },
    }),
  }, { ...options, timeoutMs: SERVER_BUDGETS.realtime }, async (response, signal) => {
    const payload = await readUpstreamJson(response, 64 * 1024, signal);
    if (!isRecord(payload) || typeof payload.value !== 'string' || !payload.value.startsWith('ek_') ||
        payload.value.length > 4096 || typeof payload.expires_at !== 'number' ||
        !Number.isSafeInteger(payload.expires_at) || payload.expires_at <= Date.now() / 1000) {
      throw new UpstreamError('invalid');
    }
    return { clientSecret: payload.value, expiresAt: payload.expires_at, model: options.model, sampleRate: REALTIME_SAMPLE_RATE };
  });
}
