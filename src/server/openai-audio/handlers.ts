import {
  AI_VOICE_DISCLOSURE_HEADER, AI_VOICE_DISCLOSURE_VALUE, AUDIO_MODEL_HEADER,
  getOpenAIAudioConfig, MAX_AUDIO_BYTES, MAX_SPEECH_BODY_BYTES,
  type OpenAIAudioEnvironment, validateAudioFile, validateSpeechText,
} from './contracts';
import {
  API_HEADERS, ApiError, apiBoundary, apiFailure, apiJson, readRequestBytes,
  readRequestJson, requireClient, requireJson,
} from '../http/api';
import { isRecord } from '../http/upstream';
import { synthesizeAudio, transcribeAudio } from './provider';

export interface OpenAIAudioHandlerDependencies {
  environment?: OpenAIAudioEnvironment;
  fetch?: typeof globalThis.fetch;
}

export function handleVoiceCapabilitiesRequest(request: Request, dependencies: OpenAIAudioHandlerDependencies = {}): Response {
  try {
    requireClient(request);
    const config = getOpenAIAudioConfig(dependencies.environment);
    return apiJson({ transcription: config.apiKey ? 'ready' : 'unconfigured' });
  } catch (error) { return apiFailure(error); }
}

export function handleTranscribeRequest(request: Request, dependencies: OpenAIAudioHandlerDependencies = {}): Promise<Response> {
  return apiBoundary(async () => {
    requireClient(request);
    if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'multipart/form-data') {
      throw new ApiError(415, 'invalid_content_type', 'Send multipart/form-data with the recording in the audio field.');
    }
    const config = getOpenAIAudioConfig(dependencies.environment);
    if (!config.apiKey) throw new ApiError(503, 'openai_not_configured', 'Voice transcription is temporarily unavailable.');
    const bytes = await readRequestBytes(request, MAX_AUDIO_BYTES + 128 * 1024, 'audio_too_large');
    let audio: File;
    try {
      const headers = new Headers(request.headers);
      headers.delete('content-length');
      const boundedRequest = new Request(request.url, { method: 'POST', headers, body: bytes });
      const form = await boundedRequest.formData() as unknown as { getAll(name: string): (File | string)[] };
      const files = form.getAll('audio');
      if (files.length !== 1 || typeof files[0] === 'string' || !files[0]) {
        throw new ApiError(400, 'missing_audio', 'Attach one audio file in the audio field.');
      }
      audio = files[0];
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, 'invalid_content_type', 'The multipart request could not be read.');
    }
    const validation = validateAudioFile(audio);
    if (!validation.ok) throw new ApiError(validation.status, validation.code, validation.message);
    const transcript = await transcribeAudio(audio, { config, fetch: dependencies.fetch, signal: request.signal });
    return apiJson({ transcript, provider: 'openai', model: config.transcribeModel });
  });
}

export function handleSpeechRequest(request: Request, dependencies: OpenAIAudioHandlerDependencies = {}): Promise<Response> {
  return apiBoundary(async () => {
    requireClient(request);
    requireJson(request);
    const input = await readRequestJson(request, MAX_SPEECH_BODY_BYTES);
    const validation = validateSpeechText(isRecord(input) ? input.text : undefined);
    if (!validation.ok) throw new ApiError(400, 'invalid_text', validation.message);
    const config = getOpenAIAudioConfig(dependencies.environment);
    if (!config.apiKey) throw new ApiError(503, 'openai_not_configured', 'Generated speech is temporarily unavailable.');
    const audio = await synthesizeAudio(validation.text, { config, fetch: dependencies.fetch, signal: request.signal });
    return new Response(audio, {
      headers: {
        ...API_HEADERS,
        [AI_VOICE_DISCLOSURE_HEADER]: AI_VOICE_DISCLOSURE_VALUE,
        [AUDIO_MODEL_HEADER]: config.speechModel,
        'Content-Disposition': 'inline; filename="murmur-response.mp3"',
        'Content-Length': String(audio.byteLength),
        'Content-Type': 'audio/mpeg',
      },
    });
  });
}
