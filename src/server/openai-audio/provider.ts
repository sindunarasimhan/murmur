import { SERVER_BUDGETS } from '../config';
import { isRecord, readUpstreamBytes, readUpstreamJson, requestUpstream, UpstreamError } from '../http/upstream';
import { audioUploadFileName, MAX_SPEECH_AUDIO_BYTES, type OpenAIAudioConfig } from './contracts';

type Options = { config: OpenAIAudioConfig; fetch?: typeof fetch; signal: AbortSignal };

export async function transcribeAudio(audio: File, options: Options): Promise<string> {
  const form = new FormData();
  form.append('model', options.config.transcribeModel);
  form.append('file', audio, audioUploadFileName(audio));
  return requestUpstream('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${options.config.apiKey}` }, body: form,
  }, { ...options, timeoutMs: SERVER_BUDGETS.transcription }, async (response, signal) => {
    const payload = await readUpstreamJson(response, 64 * 1024, signal);
    if (!isRecord(payload) || typeof payload.text !== 'string' || !payload.text.trim()) throw new UpstreamError('empty');
    return payload.text.trim();
  });
}

export async function synthesizeAudio(text: string, options: Options) {
  const { config } = options;
  return requestUpstream('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.speechModel, voice: config.speechVoice, input: text, response_format: 'mp3',
      ...(config.speechModel.startsWith('gpt-4o-mini-tts') ? {
        instructions: 'Speak warmly and clearly with calm confidence. Keep a thoughtful, conversational pace distinct from podcast audio.',
      } : {}),
    }),
  }, { ...options, timeoutMs: SERVER_BUDGETS.speech }, async (response, signal) => {
    const type = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (type !== 'audio/mpeg' && type !== 'audio/mp3') throw new UpstreamError('invalid');
    const bytes = await readUpstreamBytes(response, MAX_SPEECH_AUDIO_BYTES, signal);
    if (!bytes.byteLength) throw new UpstreamError('empty');
    return bytes;
  });
}
