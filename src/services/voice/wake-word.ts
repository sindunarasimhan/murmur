const MURMUR_WAKE_WORD = /\bhey[\s,]+murmur\b[\s,.:;!?—-]*/i;

export type WakeWordStatus = 'inactive' | 'arming' | 'ready' | 'unavailable';

export type WakeWordMatch = {
  matched: boolean;
  request: string;
};

/** Extract only the listener's request after the first complete wake phrase. */
export function matchMurmurWakeWord(transcript: string): WakeWordMatch {
  const match = MURMUR_WAKE_WORD.exec(transcript.normalize('NFKC'));
  if (!match) return { matched: false, request: '' };

  return {
    matched: true,
    request: transcript.slice(match.index + match[0].length).trim(),
  };
}
