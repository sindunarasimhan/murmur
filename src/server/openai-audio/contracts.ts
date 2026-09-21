import { DEFAULT_MODELS, getServerConfig } from '../config';

export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
export const MAX_SPEECH_CHARACTERS = 3_500;
export const MAX_SPEECH_BODY_BYTES = 32 * 1024;
export const MAX_SPEECH_AUDIO_BYTES = 8 * 1024 * 1024;

export const DEFAULT_TRANSCRIBE_MODEL = DEFAULT_MODELS.transcription;
export const DEFAULT_SPEECH_MODEL = DEFAULT_MODELS.speech;
export const DEFAULT_SPEECH_VOICE = DEFAULT_MODELS.voice;

export const AI_VOICE_DISCLOSURE_HEADER = 'X-Murmur-Voice-Disclosure';
export const AI_VOICE_DISCLOSURE_VALUE = 'ai-generated';
export const AUDIO_MODEL_HEADER = 'X-Murmur-Model';

const SUPPORTED_AUDIO_MIME_TYPES = new Set([
  'application/ogg',
  'audio/flac',
  'audio/m4a',
  'audio/mp3',
  'audio/mp4',
  'audio/mpeg',
  'audio/mpga',
  'audio/ogg',
  'audio/wav',
  'audio/wave',
  'audio/webm',
  'audio/x-flac',
  'audio/x-m4a',
  'audio/x-wav',
  'video/mp4',
  'video/webm',
]);

export type AudioApiErrorCode =
  | 'audio_too_large'
  | 'empty_audio'
  | 'invalid_content_type'
  | 'invalid_client'
  | 'invalid_json'
  | 'invalid_text'
  | 'missing_audio'
  | 'openai_not_configured'
  | 'payload_too_large'
  | 'request_cancelled'
  | 'invalid_request'
  | 'provider_timeout'
  | 'provider_authentication'
  | 'provider_quota'
  | 'provider_unavailable'
  | 'empty_provider_response'
  | 'unsupported_audio_type'
  | 'upstream_error';

export interface AudioApiErrorBody {
  error: {
    code: AudioApiErrorCode;
    message: string;
    retryable: boolean;
  };
}

export interface TranscriptionSuccessBody {
  transcript: string;
  provider: 'openai';
  model: string;
}

export interface VoiceCapabilitiesBody {
  transcription: 'ready' | 'unconfigured';
}

export type AudioFileValidation =
  | { ok: true }
  | {
      ok: false;
      code: 'audio_too_large' | 'empty_audio' | 'unsupported_audio_type';
      message: string;
      status: 400 | 413 | 415;
    };

export interface OpenAIAudioEnvironment {
  OPENAI_API_KEY?: string;
  OPENAI_SPEECH_MODEL?: string;
  OPENAI_SPEECH_VOICE?: string;
  OPENAI_TRANSCRIBE_MODEL?: string;
}

export interface OpenAIAudioConfig {
  apiKey: string | null;
  speechModel: string;
  speechVoice: string;
  transcribeModel: string;
}

function serverEnvironment(): OpenAIAudioEnvironment {
  return {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_SPEECH_MODEL: process.env.OPENAI_SPEECH_MODEL,
    OPENAI_SPEECH_VOICE: process.env.OPENAI_SPEECH_VOICE,
    OPENAI_TRANSCRIBE_MODEL: process.env.OPENAI_TRANSCRIBE_MODEL,
  };
}

export function getOpenAIAudioConfig(
  environment: OpenAIAudioEnvironment = serverEnvironment(),
): OpenAIAudioConfig {
  const config = getServerConfig(environment).openai;
  return {
    apiKey: config.apiKey ?? null,
    speechModel: config.speechModel,
    speechVoice: config.speechVoice,
    transcribeModel: config.transcribeModel,
  };
}

export function validateAudioFile(
  file: Pick<File, 'size' | 'type'>,
): AudioFileValidation {
  if (file.size === 0) {
    return {
      ok: false,
      code: 'empty_audio',
      message: 'The audio file is empty.',
      status: 400,
    };
  }

  if (file.size > MAX_AUDIO_BYTES) {
    return {
      ok: false,
      code: 'audio_too_large',
      message: 'Audio must be 15 MB or smaller.',
      status: 413,
    };
  }

  if (!SUPPORTED_AUDIO_MIME_TYPES.has(file.type.toLowerCase())) {
    return {
      ok: false,
      code: 'unsupported_audio_type',
      message: 'Use an MP3, MP4, M4A, WAV, WebM, OGG, or FLAC audio file.',
      status: 415,
    };
  }

  return { ok: true };
}

export function validateSpeechText(value: unknown):
  | { ok: true; text: string }
  | { ok: false; message: string } {
  if (typeof value !== 'string') {
    return { ok: false, message: 'Text must be a string.' };
  }

  const text = value.trim();
  if (text.length === 0) {
    return { ok: false, message: 'Text cannot be empty.' };
  }

  if (text.length > MAX_SPEECH_CHARACTERS) {
    return {
      ok: false,
      message: `Text must be ${MAX_SPEECH_CHARACTERS.toLocaleString('en-US')} characters or fewer.`,
    };
  }

  return { ok: true, text };
}

export function audioUploadFileName(file: Pick<File, 'name' | 'type'>): string {
  const suppliedName = file.name.trim();
  if (/\.(?:flac|m4a|mp3|mp4|mpeg|mpga|ogg|wav|webm)$/i.test(suppliedName)) {
    return suppliedName;
  }

  const extensionByMimeType: Record<string, string> = {
    'application/ogg': 'ogg',
    'audio/flac': 'flac',
    'audio/m4a': 'm4a',
    'audio/mp3': 'mp3',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/mpga': 'mpga',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/wave': 'wav',
    'audio/webm': 'webm',
    'audio/x-flac': 'flac',
    'audio/x-m4a': 'm4a',
    'audio/x-wav': 'wav',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
  };
  const extension = extensionByMimeType[file.type.toLowerCase()] ?? 'audio';
  const baseName = suppliedName.replace(/\.+$/, '') || 'murmur-recording';

  return `${baseName}.${extension}`;
}
