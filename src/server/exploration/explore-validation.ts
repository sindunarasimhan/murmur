import {
  EXPLORE_INTENTS,
  EXPLORE_LIMITS,
  type ExploreIntent,
  type ExploreRequest,
} from './explore-contract';

type ValidationResult =
  | { ok: true; value: ExploreRequest }
  | { ok: false; message: string };

type TextValidationResult =
  | { ok: true; value: string }
  | { ok: false; message: string };

const TOP_LEVEL_KEYS = new Set([
  'question',
  'intent',
  'episode',
  'playbackPositionSeconds',
  'transcriptContext',
  'history',
]);
const EPISODE_KEYS = new Set(['title', 'showTitle']);
const HISTORY_KEYS = new Set(['question', 'answer']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function cleanText(value: string, preserveLines = false): string {
  const withoutControls = value
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\r\n?/g, '\n');

  if (!preserveLines) return withoutControls.replace(/\s+/g, ' ').trim();

  return withoutControls
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function readText(
  value: unknown,
  field: string,
  maximum: number,
  options: { allowEmpty?: boolean; preserveLines?: boolean } = {},
): TextValidationResult {
  if (typeof value !== 'string') {
    return { ok: false, message: `${field} must be a string.` };
  }
  if (value.length > maximum) {
    return {
      ok: false,
      message: `${field} must be ${maximum.toLocaleString('en-US')} characters or fewer.`,
    };
  }

  const cleaned = cleanText(value, options.preserveLines);
  if (cleaned.length > maximum) {
    return {
      ok: false,
      message: `${field} must be ${maximum.toLocaleString('en-US')} characters or fewer.`,
    };
  }
  if (!options.allowEmpty && cleaned.length === 0) {
    return { ok: false, message: `${field} cannot be empty.` };
  }
  return { ok: true, value: cleaned };
}

function isExploreIntent(value: unknown): value is ExploreIntent {
  return (
    typeof value === 'string' &&
    (EXPLORE_INTENTS as readonly string[]).includes(value)
  );
}

export function validateExploreRequest(value: unknown): ValidationResult {
  if (!isRecord(value)) {
    return { ok: false, message: 'Request body must be a JSON object.' };
  }
  if (!hasOnlyKeys(value, TOP_LEVEL_KEYS)) {
    return { ok: false, message: 'Request body contains an unexpected field.' };
  }

  const question = readText(
    value.question,
    'question',
    EXPLORE_LIMITS.questionCharacters,
  );
  if (!question.ok) return question;

  if (!isExploreIntent(value.intent)) {
    return { ok: false, message: 'intent is not supported.' };
  }

  if (!isRecord(value.episode) || !hasOnlyKeys(value.episode, EPISODE_KEYS)) {
    return {
      ok: false,
      message: 'episode must contain only title and showTitle.',
    };
  }
  const title = readText(
    value.episode.title,
    'episode.title',
    EXPLORE_LIMITS.episodeTitleCharacters,
  );
  if (!title.ok) return title;
  const showTitle = readText(
    value.episode.showTitle,
    'episode.showTitle',
    EXPLORE_LIMITS.showTitleCharacters,
  );
  if (!showTitle.ok) return showTitle;

  const position = value.playbackPositionSeconds;
  if (
    typeof position !== 'number' ||
    !Number.isFinite(position) ||
    position < 0 ||
    position > EXPLORE_LIMITS.playbackPositionSeconds
  ) {
    return {
      ok: false,
      message: `playbackPositionSeconds must be between 0 and ${EXPLORE_LIMITS.playbackPositionSeconds}.`,
    };
  }

  const transcriptContext = readText(
    value.transcriptContext,
    'transcriptContext',
    EXPLORE_LIMITS.transcriptContextCharacters,
    { allowEmpty: true, preserveLines: true },
  );
  if (!transcriptContext.ok) return transcriptContext;

  let history: ExploreRequest['history'];
  if (value.history !== undefined) {
    if (!Array.isArray(value.history)) {
      return { ok: false, message: 'history must be an array.' };
    }
    if (value.history.length > EXPLORE_LIMITS.historyTurns) {
      return {
        ok: false,
        message: `history must contain no more than ${EXPLORE_LIMITS.historyTurns} turns.`,
      };
    }

    history = [];
    for (const [index, turn] of value.history.entries()) {
      if (!isRecord(turn) || !hasOnlyKeys(turn, HISTORY_KEYS)) {
        return {
          ok: false,
          message: `history[${index}] must contain only question and answer.`,
        };
      }
      const historyQuestion = readText(
        turn.question,
        `history[${index}].question`,
        EXPLORE_LIMITS.historyQuestionCharacters,
      );
      if (!historyQuestion.ok) return historyQuestion;
      const historyAnswer = readText(
        turn.answer,
        `history[${index}].answer`,
        EXPLORE_LIMITS.historyAnswerCharacters,
      );
      if (!historyAnswer.ok) return historyAnswer;
      history.push({
        question: historyQuestion.value,
        answer: historyAnswer.value,
      });
    }
  }

  return {
    ok: true,
    value: {
      question: question.value,
      intent: value.intent,
      episode: { title: title.value, showTitle: showTitle.value },
      playbackPositionSeconds: position,
      transcriptContext: transcriptContext.value,
      ...(history ? { history } : {}),
    },
  };
}
