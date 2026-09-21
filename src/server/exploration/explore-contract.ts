export const EXPLORE_INTENTS = [
  'clarify',
  'factual',
  'quantitative',
  'debate',
  'abstract',
] as const;

export type ExploreIntent = (typeof EXPLORE_INTENTS)[number];

export type ExploreHistoryTurn = {
  question: string;
  answer: string;
};

export type ExploreRequest = {
  question: string;
  intent: ExploreIntent;
  episode: {
    title: string;
    showTitle: string;
  };
  playbackPositionSeconds: number;
  transcriptContext: string;
  history?: ExploreHistoryTurn[];
};

export type ExploreSuccessResponse = {
  answer: string;
  provider: 'openai';
  model: string;
};

export type ExploreErrorCode =
  | 'invalid_json'
  | 'invalid_request'
  | 'payload_too_large'
  | 'request_cancelled'
  | 'provider_not_configured'
  | 'provider_timeout'
  | 'provider_unavailable'
  | 'provider_error'
  | 'upstream_error'
  | 'provider_authentication'
  | 'provider_quota'
  | 'empty_provider_response';

export type ExploreErrorResponse = {
  error: {
    code: ExploreErrorCode;
    message: string;
    retryable: boolean;
  };
};

export const EXPLORE_LIMITS = {
  bodyBytes: 64 * 1024,
  questionCharacters: 1_200,
  episodeTitleCharacters: 300,
  showTitleCharacters: 300,
  transcriptContextCharacters: 16_000,
  historyTurns: 6,
  historyQuestionCharacters: 1_200,
  historyAnswerCharacters: 5_000,
  playbackPositionSeconds: 7 * 24 * 60 * 60,
} as const;
