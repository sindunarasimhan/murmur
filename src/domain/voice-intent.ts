import type { AdSegment } from '@/domain/podcast';

export type InquiryCategory =
  | 'abstract'
  | 'clarify'
  | 'debate'
  | 'factual'
  | 'quantitative';

export type VoiceIntent =
  | { kind: 'command'; command: 'pause' | 'play' | 'skip-ad' }
  | { kind: 'command'; command: 'seek-relative'; deltaSeconds: number }
  | { kind: 'inquiry'; category: InquiryCategory }
  | { kind: 'unknown' };

export type VerifiedAdResolution =
  | {
      kind: 'resolved';
      seekToSeconds: number;
      segment: AdSegment;
    }
  | {
      kind: 'unavailable';
      reason:
        | 'ambiguous-segments'
        | 'invalid-request'
        | 'no-verified-segment';
    };

export type ResolveVerifiedAdInput = {
  assetIdentityKind: 'content-hash' | 'feed-locator' | 'publisher-version';
  assetVersionId: string;
  currentSeconds: number;
  segments: readonly AdSegment[];
  minimumConfidence?: number;
};

export const DEFAULT_AD_CONFIDENCE = 0.95;

const MAX_RELATIVE_SEEK_SECONDS = 60 * 60;

const skipAdPattern =
  /^(?:skip|jump past|move past|get past)\s+(?:(?:this|the|current)\s+)?(?:ad|ads|advert|advertisement|commercial)(?:\s+break)?$/;

const playPattern =
  /^(?:play|resume|continue|start)(?:\s+(?:playing\s+)?(?:(?:the|this)\s+)?(?:podcast|episode|audio|show|playback))?$/;

const pausePattern =
  /^(?:pause(?:\s+(?:(?:the|this)\s+)?(?:podcast|episode|audio|show|playback))?|stop\s+(?:playing\s+)?(?:(?:the|this)\s+)?(?:podcast|episode|audio|show|playback))$/;

const numberWords: Readonly<Record<string, number>> = {
  a: 1,
  an: 1,
  eight: 8,
  eighteen: 18,
  eighty: 80,
  eleven: 11,
  fifteen: 15,
  fifty: 50,
  five: 5,
  forty: 40,
  four: 4,
  fourteen: 14,
  nine: 9,
  nineteen: 19,
  one: 1,
  seven: 7,
  seventeen: 17,
  seventy: 70,
  six: 6,
  sixteen: 16,
  sixty: 60,
  ten: 10,
  thirteen: 13,
  thirty: 30,
  three: 3,
  twelve: 12,
  twenty: 20,
  two: 2,
};

const tensWords = new Set([
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
]);

function normalizeUtterance(utterance: string): string {
  return utterance
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[–—-]/g, ' ')
    .replace(/[,;:]+/g, ' ')
    .replace(/[.!?？]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function unwrapCommandRequest(utterance: string): string {
  return utterance
    .replace(/^(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)/, '')
    .replace(/^(?:please|kindly)\s+/, '')
    .replace(/\s+please$/, '')
    .trim();
}

function parseSpokenNumber(value: string): number | undefined {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;

  if (value === 'half' || value === 'half a' || value === 'half an') return 0.5;

  const words = value.split(/\s+/);
  if (words.length === 0 || words.length > 2) return undefined;

  const firstWord = words[0];
  if (!firstWord) return undefined;

  const firstAmount = numberWords[firstWord];
  if (firstAmount === undefined) return undefined;

  if (words.length === 1) return firstAmount;

  const secondWord = words[1];
  const secondAmount = secondWord ? numberWords[secondWord] : undefined;
  if (
    !tensWords.has(firstWord) ||
    secondAmount === undefined ||
    secondAmount < 1 ||
    secondAmount > 9
  ) {
    return undefined;
  }

  return firstAmount + secondAmount;
}

function toSeekSeconds(amountText: string, unit: string): number | undefined {
  const amount = parseSpokenNumber(amountText.trim());
  if (amount === undefined || amount <= 0) return undefined;

  const multiplier = /^(?:hour|hours|hr|hrs)$/.test(unit)
    ? 60 * 60
    : /^(?:minute|minutes|min|mins)$/.test(unit)
      ? 60
      : 1;
  const seconds = amount * multiplier;

  if (!Number.isFinite(seconds) || seconds > MAX_RELATIVE_SEEK_SECONDS) {
    return undefined;
  }

  return Math.round(seconds * 1000) / 1000;
}

function parseRelativeSeek(commandBody: string): number | undefined {
  const directional = commandBody.match(
    /^(?:(?:skip|jump|go|move|seek)\s+)?(ahead|forward|forwards|back|backward|backwards)\s+(?:by\s+)?([a-z\d. ]+?)\s+(seconds?|secs?|minutes?|mins?|hours?|hrs?)$/,
  );

  if (directional) {
    const [, direction, amountText, unit] = directional;
    if (!direction || !amountText || !unit) return undefined;

    const seconds = toSeekSeconds(amountText, unit);
    if (seconds === undefined) return undefined;

    return /^(?:back|backward|backwards)$/.test(direction) ? -seconds : seconds;
  }

  const rewind = commandBody.match(
    /^rewind\s+(?:by\s+)?([a-z\d. ]+?)\s+(seconds?|secs?|minutes?|mins?|hours?|hrs?)$/,
  );
  if (rewind) {
    const [, amountText, unit] = rewind;
    if (!amountText || !unit) return undefined;

    const seconds = toSeekSeconds(amountText, unit);
    return seconds === undefined ? undefined : -seconds;
  }

  const skipByAmount = commandBody.match(
    /^skip\s+(?:ahead\s+)?(?:by\s+)?([a-z\d. ]+?)\s+(seconds?|secs?|minutes?|mins?|hours?|hrs?)$/,
  );
  if (!skipByAmount) return undefined;

  const [, amountText, unit] = skipByAmount;
  return amountText && unit ? toSeekSeconds(amountText, unit) : undefined;
}

function looksLikeInquiry(utterance: string, originalUtterance: string): boolean {
  if (/[?？]\s*$/.test(originalUtterance)) return true;

  return /^(?:(?:can|could|would|will)\s+you\s+)?(?:argue|calculate|challenge|clarify|define|did|do|does|explain|explore|fact check|go deeper|how|is|make (?:the )?(?:strongest )?case|quantify|tell me|was|were|what|when|where|which|who|why)\b/.test(
    utterance,
  );
}

function classifyInquiry(utterance: string): InquiryCategory {
  if (
    /\b(?:calculate|calculation|how many|how much|number|numbers|percent|percentage|probability|quantif(?:y|ied)|rate|ratio|statistic|total)\b/.test(
      utterance,
    )
  ) {
    return 'quantitative';
  }

  if (
    /\b(?:argue|case against|case for|challenge|counterargument|counterpoint|debate|devil's advocate|disagree|other side|strongest case)\b/.test(
      utterance,
    )
  ) {
    return 'debate';
  }

  if (
    /\b(?:consciousness|ethical|ethically|free will|human nature|identity|moral|morally|philosoph(?:y|ical)|society|values)\b|\bwhat does (?:that|this) imply\b/.test(
      utterance,
    )
  ) {
    return 'abstract';
  }

  if (
    /\b(?:who|when|where)\b|^(?:(?:can|could|would|will)\s+you\s+)?which\b|\b(?:citation|cite|evidence|fact check|source|true or false|what year)\b|\b(?:did|does|is|was|were) (?:that|this|the claim) (?:actually )?(?:happen|true|correct)\b/.test(
      utterance,
    )
  ) {
    return 'factual';
  }

  return 'clarify';
}

export function routeVoiceIntent(utterance: string): VoiceIntent {
  const normalized = normalizeUtterance(utterance);
  if (!normalized) return { kind: 'unknown' };

  const commandBody = unwrapCommandRequest(normalized);

  if (skipAdPattern.test(commandBody)) {
    return { kind: 'command', command: 'skip-ad' };
  }

  if (playPattern.test(commandBody)) {
    return { kind: 'command', command: 'play' };
  }

  if (pausePattern.test(commandBody)) {
    return { kind: 'command', command: 'pause' };
  }

  const deltaSeconds = parseRelativeSeek(commandBody);
  if (deltaSeconds !== undefined) {
    return { kind: 'command', command: 'seek-relative', deltaSeconds };
  }

  if (looksLikeInquiry(normalized, utterance)) {
    return { kind: 'inquiry', category: classifyInquiry(normalized) };
  }

  return { kind: 'unknown' };
}

function isUsableSegment(
  segment: AdSegment,
  assetVersionId: string,
  currentSeconds: number,
  minimumConfidence: number,
): boolean {
  return (
    segment.assetVersionId === assetVersionId &&
    segment.verified === true &&
    Number.isFinite(segment.confidence) &&
    segment.confidence >= minimumConfidence &&
    segment.confidence <= 1 &&
    Number.isFinite(segment.startSeconds) &&
    Number.isFinite(segment.endSeconds) &&
    segment.startSeconds >= 0 &&
    segment.endSeconds > segment.startSeconds &&
    currentSeconds >= segment.startSeconds &&
    currentSeconds < segment.endSeconds
  );
}

export function resolveVerifiedAdSegment({
  assetIdentityKind,
  assetVersionId,
  currentSeconds,
  segments,
  minimumConfidence = DEFAULT_AD_CONFIDENCE,
}: ResolveVerifiedAdInput): VerifiedAdResolution {
  if (
    assetIdentityKind === 'feed-locator' ||
    !assetVersionId.trim() ||
    !Number.isFinite(currentSeconds) ||
    currentSeconds < 0
  ) {
    return { kind: 'unavailable', reason: 'invalid-request' };
  }

  if (
    !Number.isFinite(minimumConfidence) ||
    minimumConfidence < 0 ||
    minimumConfidence > 1
  ) {
    throw new RangeError('minimumConfidence must be between 0 and 1.');
  }

  const matches = segments.filter((segment) =>
    isUsableSegment(
      segment,
      assetVersionId,
      currentSeconds,
      minimumConfidence,
    ),
  );

  if (matches.length === 0) {
    return { kind: 'unavailable', reason: 'no-verified-segment' };
  }

  if (matches.length > 1) {
    return { kind: 'unavailable', reason: 'ambiguous-segments' };
  }

  const segment = matches[0];
  if (!segment) {
    return { kind: 'unavailable', reason: 'no-verified-segment' };
  }

  return {
    kind: 'resolved',
    seekToSeconds: segment.endSeconds,
    segment,
  };
}
