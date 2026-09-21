import type { PodcastEpisode, TranscriptCue } from '@/domain/podcast';
import type { InquiryCategory } from '@/domain/voice-intent';
import { transcriptWindow } from '@/services/rss/parse-transcript';

type ContextualAnswerInput = {
  category: InquiryCategory;
  episode: PodcastEpisode;
  positionSeconds: number;
  priorTurns?: readonly {
    question: string;
    answer: string;
  }[];
  transcript: readonly TranscriptCue[];
  utterance: string;
};

const topicPrimers: readonly {
  pattern: RegExp;
  primer: string;
}[] = [
  {
    pattern: /chapter/i,
    primer:
      'Podcast chapters are time-based markers published with an episode. They let a listening app name sections, show context, and move to a precise moment without changing the underlying audio.',
  },
  {
    pattern: /transcript/i,
    primer:
      'A timed podcast transcript maps words to moments in the audio. That timing is what lets Murmur ground a question in the passage you were actually hearing instead of treating the whole episode as one undifferentiated document.',
  },
  {
    pattern: /wallet/i,
    primer:
      'In Podcasting 2.0, wallet metadata describes where listener payments can be routed. The broader idea is to make value exchange part of the open feed rather than a private feature of one listening platform.',
  },
  {
    pattern: /fund/i,
    primer:
      'The funding idea here is direct listener support expressed through open podcast metadata. It shifts some control from a platform’s business model toward a relationship between the listener and publisher.',
  },
  {
    pattern: /podcasting 2\.0|basics/i,
    primer:
      'Podcasting 2.0 extends ordinary RSS with open metadata for features such as transcripts, chapters, people, and payments. Apps can interpret those additions while the feed remains portable between platforms.',
  },
];

function cleanExcerpt(cues: readonly TranscriptCue[]): string | undefined {
  const text = cues
    .map((cue) => cue.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  return text.length > 210 ? `${text.slice(0, 207).trimEnd()}…` : text;
}

function primerFor(episode: PodcastEpisode): string {
  const searchable = `${episode.title} ${episode.description}`;
  return (
    topicPrimers.find((candidate) => candidate.pattern.test(searchable))?.primer ??
    'This part is developing an idea inside the episode rather than presenting a standalone conclusion. The surrounding passage matters, so Murmur keeps the current timestamp attached to the question.'
  );
}

function priorAnswerFocus(answer: string): string {
  if (/open metadata/i.test(answer)) return 'the promise and limits of open metadata';
  if (/transcript|timestamp|timed context/i.test(answer)) {
    return 'how timed context shapes the interpretation';
  }
  if (/publisher|platform|listener/i.test(answer)) {
    return 'who controls the listening experience';
  }
  if (/surrounding passage|context-dependent|reading/i.test(answer)) {
    return 'a context-dependent reading of the passage';
  }
  return 'the previous interpretation';
}

export function buildContextualAnswer({
  category,
  episode,
  positionSeconds,
  priorTurns = [],
  transcript,
  utterance,
}: ContextualAnswerInput): string {
  const nearby = transcriptWindow([...transcript], positionSeconds, 28, 8);
  const excerpt = cleanExcerpt(nearby);
  const primer = primerFor(episode);
  const hasBroadCue = nearby.some(
    (cue) => cue.endSeconds - cue.startSeconds > 30,
  );
  const contextLead = hasBroadCue
    ? 'The feed groups this moment into a broad transcript section, so I’m treating it as section-level—not word-level—context.'
    : excerpt
      ? `Around this moment, the episode says: “${excerpt}”`
      : '';
  const previousTurn = priorTurns.at(-1);
  const previousFocus = previousTurn
    ? priorAnswerFocus(previousTurn.answer)
    : undefined;
  const continuityLead = previousTurn
    ? category === 'debate'
      ? `The previous answer centered ${previousFocus}; I’ll test that framing directly.`
      : `Building on ${previousFocus}, I’ll keep the same thread in view.`
    : '';
  const hasOpenMetadataTopic =
    /chapter|transcript|wallet|fund|podcasting 2\.0|basics/i.test(
      `${episode.title} ${episode.description}`,
    ) || /open metadata/i.test(previousTurn?.answer ?? '');
  const debateCounterpoint = hasOpenMetadataTopic
    ? 'The strongest counterpoint is that open metadata only creates possibility; it does not guarantee adoption, accuracy, or a better listener experience. The argument turns on whether enough publishers and apps coordinate around the same standard.'
    : 'The strongest counterpoint is that the surrounding passage may support a different reading. Without more precise context or outside evidence, I should treat this as an interpretation rather than a settled conclusion.';

  switch (category) {
    case 'quantitative':
      return [
        contextLead,
        continuityLead,
        'The transcript gives us the claim, but not enough structured evidence to recalculate it responsibly yet. I’d separate the stated number, its denominator and time period, then compare it with the connected sources before deciding whether it adds up.',
      ]
        .filter(Boolean)
        .join(' ');
    case 'debate':
      return [
        contextLead,
        continuityLead,
        continuityLead ? '' : primer,
        debateCounterpoint,
      ]
        .filter(Boolean)
        .join(' ');
    case 'abstract':
      return [
        contextLead,
        continuityLead,
        continuityLead ? '' : primer,
        'At a deeper level, this raises a tension between the episode’s immediate claim and the assumptions beneath it. I’d ask who benefits, what tradeoff is being accepted, and what new evidence would change the conclusion.',
      ]
        .filter(Boolean)
        .join(' ');
    case 'factual':
      return [
        contextLead,
        continuityLead,
        'I can anchor the question to what the episode says, but this local prototype is not connected to outside evidence yet. I would verify the named source and date before presenting the claim as fact.',
      ]
        .filter(Boolean)
        .join(' ');
    case 'clarify':
    default:
      return [
        contextLead,
        continuityLead,
        continuityLead ? '' : primer,
        utterance ? 'That is the simplest useful reading here.' : '',
      ]
        .filter(Boolean)
        .join(' ');
  }
}
