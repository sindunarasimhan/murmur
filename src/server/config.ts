/** Server-only settings. Never import this module from a screen or client service. */
export const DEFAULT_MODELS = {
  answer: 'gpt-5.4-mini',
  realtime: 'gpt-live-transcribe',
  transcription: 'gpt-4o-transcribe',
  speech: 'gpt-4o-mini-tts',
  voice: 'cedar',
  decision: 'jev-latest',
} as const;

// Provider budgets leave time for the API to return an error before the client times out.
export const SERVER_BUDGETS = {
  answer: 14_000,
  decision: 1_500,
  realtime: 10_000,
  transcription: 40_000,
  speech: 25_000,
  discovery: 20_000,
  directory: 6_000,
  feed: 8_000,
} as const;

export interface ServerEnvironment {
  OPENAI_API_KEY?: string;
  OPENAI_RESPONSE_MODEL?: string;
  OPENAI_FAST_RESPONSE_MODEL?: string;
  OPENAI_REALTIME_TRANSCRIBE_MODEL?: string;
  OPENAI_TRANSCRIBE_MODEL?: string;
  OPENAI_SPEECH_MODEL?: string;
  OPENAI_SPEECH_VOICE?: string;
  TYPESAFE_API_KEY?: string;
  TYPESAFE_MODEL?: string;
}

export function getServerConfig(environment: ServerEnvironment = process.env as ServerEnvironment) {
  const value = (key: keyof ServerEnvironment) => environment[key]?.trim() || undefined;
  const answerModel = value('OPENAI_RESPONSE_MODEL') ?? DEFAULT_MODELS.answer;
  return {
    openai: {
      apiKey: value('OPENAI_API_KEY'),
      answerModel,
      // Opt in to a smaller model only after evaluating it on real listener questions.
      fastAnswerModel: value('OPENAI_FAST_RESPONSE_MODEL') ?? answerModel,
      realtimeModel: value('OPENAI_REALTIME_TRANSCRIBE_MODEL') ?? DEFAULT_MODELS.realtime,
      transcribeModel: value('OPENAI_TRANSCRIBE_MODEL') ?? DEFAULT_MODELS.transcription,
      speechModel: value('OPENAI_SPEECH_MODEL') ?? DEFAULT_MODELS.speech,
      speechVoice: value('OPENAI_SPEECH_VOICE') ?? DEFAULT_MODELS.voice,
    },
    typesafe: {
      apiKey: value('TYPESAFE_API_KEY'),
      model: value('TYPESAFE_MODEL') ?? DEFAULT_MODELS.decision,
    },
  };
}

export type ServerConfig = ReturnType<typeof getServerConfig>;
