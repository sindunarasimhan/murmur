const small = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const tens: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const units: Record<string, number> = { second: 1, seconds: 1, sec: 1, secs: 1, minute: 60, minutes: 60, min: 60, mins: 60, hour: 3600, hours: 3600, hr: 3600, hrs: 3600 };
const words = [...small, ...Object.keys(tens), 'hundred', 'thousand', 'and', 'a', 'an', 'half', 'quarter', 'point'].join('|');
const amountPattern = `(?:\\d+(?:,\\d{3})*(?:\\.\\d+)?|(?:${words.split('|').filter((word) => !['and', 'point'].includes(word)).join('|')})(?:[ -]+(?:${words}))*)`;
const durationPattern = `${amountPattern}\\s+(?:${Object.keys(units).sort((a, b) => b.length - a.length).join('|')})(?:\\s+and\\s+a\\s+(?:half|quarter))?`;

function number(value: string): number {
  value = value.trim().replace(/-/g, ' ');
  if (/^\d+(?:,\d{3})*(?:\.\d+)?$/.test(value)) return Number(value.replaceAll(',', ''));
  const decimal = value.match(/^(.+) point (.+)$/);
  if (decimal) {
    const digits = decimal[2]!.split(' ').map((part) => small.indexOf(part));
    return digits.every((digit) => digit >= 0 && digit < 10) ? number(decimal[1]!) + Number(`0.${digits.join('')}`) : NaN;
  }
  if (value === 'a' || value === 'an') return 1;
  if (/^(?:a |an )?half(?: a| an)?$/.test(value)) return 0.5;
  if (/^(?:a )?quarter(?: a| an)?$/.test(value)) return 0.25;
  const fraction = value.match(/^(.+) and a (half|quarter)$/);
  if (fraction) return number(fraction[1]!) + (fraction[2] === 'half' ? 0.5 : 0.25);
  const scale = value.match(/^(.+?) (thousand|hundred)(?: (?:and )?(.+))?$/);
  if (scale) {
    const multiplier = scale[2] === 'thousand' ? 1000 : 100;
    const head = number(scale[1]!); const tail = scale[3] ? number(scale[3]) : 0;
    return head > 0 && head < multiplier && tail >= 0 && tail < multiplier ? head * multiplier + tail : NaN;
  }
  if (small.includes(value)) return small.indexOf(value);
  const parts = value.split(' ');
  return tens[parts[0]!] && parts.length <= 2 && (!parts[1] || small.indexOf(parts[1]) > 0 && small.indexOf(parts[1]) < 10)
    ? tens[parts[0]!]! + (parts[1] ? small.indexOf(parts[1]) : 0) : NaN;
}

export type TimeCandidate = { text: string; seconds: number; start: number; end: number };
export function timeCandidates(utterance: string): TimeCandidate[] {
  const text = utterance.toLowerCase();
  const pattern = new RegExp(`(?<![\\w.,:+\\-])(?:\\d+:\\d{2}(?::\\d{2})?|${durationPattern})(?!(?:[\\w:]|\\.\\d))`, 'g');
  const candidates: TimeCandidate[] = [];
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    let seconds: number;
    if (raw.includes(':')) {
      const parts = raw.split(':').map(Number);
      seconds = parts.slice(1).every((part) => part < 60) ? parts.reduce((total, part) => total * 60 + part, 0) : NaN;
    } else {
      const part = raw.match(/^(.*?)\s+(seconds?|secs?|minutes?|mins?|hours?|hrs?)(?:\s+and\s+a\s+(half|quarter))?$/)!;
      seconds = (number(part[1]!) + (part[3] ? part[3] === 'half' ? 0.5 : 0.25 : 0)) * units[part[2]!]!;
    }
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > Number.MAX_SAFE_INTEGER) continue;
    const start = match.index; const end = start + raw.length;
    const previous = candidates.at(-1);
    if (previous && /^\s*(?:,\s*)?(?:and\s+)?$/.test(text.slice(previous.end, start)) && !previous.text.includes(':') && !raw.includes(':')) {
      previous.seconds += seconds; previous.end = end; previous.text = text.slice(previous.start, end);
    } else candidates.push({ text: raw, seconds, start, end });
  }
  return candidates.filter((candidate) => Number.isFinite(candidate.seconds) && candidate.seconds <= Number.MAX_SAFE_INTEGER);
}

export function exactTimeSeek(utterance: string): { delta: number } | { position: number } | undefined {
  const text = utterance.toLowerCase().trim().replace(/[.!?]+$/, '');
  const candidates = timeCandidates(text);
  if (candidates.length !== 1) return;
  const candidate = candidates[0]!;
  const before = text.slice(0, candidate.start).trim().replace(/^please\s+/, '');
  const after = text.slice(candidate.end).trim().replace(/^please$/, '');
  if (after) return;
  if (/^(?:go|jump|skip|seek) to$/.test(before)) return { position: candidate.seconds };
  if (candidate.seconds <= 0) return;
  if (/^(?:(?:go|skip|jump) )?(?:back|backward|backwards)$/.test(before) || before === 'rewind') return { delta: -candidate.seconds };
  if (/^(?:(?:go|skip|jump) )?(?:forward|forwards|ahead)$/.test(before) || /^(?:skip|fast forward)$/.test(before)) return { delta: candidate.seconds };
}
