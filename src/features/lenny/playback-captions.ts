export type PlaybackCaption = { startSeconds: number; endSeconds: number; text: string };

export function captionAt(captions: readonly PlaybackCaption[], seconds: number, characterBudget = 76): string {
  if (!Number.isFinite(seconds)) return '';
  const segment = captions.find(caption => caption.startSeconds <= seconds && seconds < caption.endSeconds);
  if (!segment) return '';
  const words = segment.text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const chunks: { text: string; words: number }[] = [];
  for (const word of words) {
    const last = chunks.at(-1);
    if (last && last.text.length + word.length + 1 <= Math.max(20, characterBudget)) {
      last.text += ` ${word}`;
      last.words += 1;
    } else chunks.push({ text: word, words: 1 });
  }
  const wordPosition = (seconds - segment.startSeconds) / (segment.endSeconds - segment.startSeconds) * words.length;
  let boundary = 0;
  for (const chunk of chunks) {
    boundary += chunk.words;
    if (wordPosition < boundary) return chunk.text;
  }
  return chunks.at(-1)?.text ?? '';
}
