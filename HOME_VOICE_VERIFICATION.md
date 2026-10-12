# Home voice handoff

## Acceptance boundary

Say “Hey Murmur”, see the recognized words remain through a generated invitation, reply with an available Lenny episode without another wake phrase, then hear that episode and see the playback transition. Empty transcripts must do nothing. The episode request is interpreted by the existing catalog service; this change adds no episode-command phrase classifier.

Automated checks do not establish physical microphone capture, audible iPhone playback, speaker echo behavior, recognition of the listener's accent, or the rendered transition. Those remain a separate phone acceptance step.

## Root causes reproduced

Four tests failed before implementation: wake-prefix stripping and invitation transitions erased displayed text; an empty transcript took the wake-only invitation path; first-partial phase permanently rejected replies beginning during assistant speech; and the invitation's own transcript became a listener request.

The real PCM test subsequently exposed a timing gap: a wake partial could outlive the follow-up timer and its final would arrive in idle. Accepted partials now keep the input deadline active until final delivery; empty final delivery releases that deadline.

Further PCM testing showed guest-name recognition errors before catalog interpretation, including “Brianne Gallagher” for the Brian Halligan fixture. The transcription session had no catalog vocabulary. It now receives bounded, deduplicated show/guest keywords from the database, not a handwritten list or a command classifier. Invalid keyword characters are filtered at the provider boundary. This uses [OpenAI's documented transcription context](https://developers.openai.com/api/docs/guides/realtime-transcription#add-transcription-context); keywords are hints, not forced output. The model and delay setting are unchanged.

## Design decision

Pstack's bug-fix, how, architect/arena, TDD and prove-it-works guidance informed this change. Two independent design reviews compared controller-owned utterance admission with capture-window provenance across the transport. A third reviewer checked the synthesis. The named Cursor model families and Comment Sicko agent are unavailable here; these were available-model reviews plus a manual added-comments/suppressions audit, not claims of running unavailable tools.

The controller-owned design is the base. It replaces permanent eligible/ineligible booleans with pending, ambient and consumed utterances. Pending records belong to a controller operation and have reception order. Partial and final inputs share admission; consumed items cannot dispatch twice. Assistant-overlapping finals wait for follow-up. The newest pending reply wins over an older finished reply. Raw display text is independent of wake-stripped request text.

Capture-window provenance was not selected for this bounded fix: it would require new commit-to-transcript correlation across the provider and backend, without establishing speaker identity. Its important constraint was retained: audio arriving from an earlier playback operation must not become a follow-up merely because transcription arrived late.

Exact normalized recent assistant-text matching is a bounded mitigation, not acoustic echo cancellation. It deliberately does not use fuzzy or substring matching. A listener repeating the exact assistant sentence during that window is indistinguishable with the current input. Mixed user and speaker audio remains a device-level risk.

## Regression coverage

- Bare wake and combined wake plus selection preserve recognized text.
- Empty events neither invite nor erase text; an empty final releases the unfinished-input deadline.
- A wake partial remains active beyond the ordinary follow-up timeout.
- Selections beginning during the greeting work whether their final arrives before or after speech completion.
- Duplicate wake/final events do not dispatch twice.
- Older partial/final items cannot replace newer recognized words or hijack a queued reply.
- Exact greeting echo is rejected; questions containing some greeting words are still interpreted.
- Backgrounding cancels voice without clearing playback; stale known items stay consumed.

## Reproducible checks

`node --import tsx --test src/features/lenny/voice-controller.test.ts`

`npm run check`

`npm run test:backend`

`FFMPEG_PATH=/path/to/ffmpeg node --import tsx scripts/evaluate-home-invocation.mts --audio`

The audio evaluation sends generated PCM through the actual continuous-transcription socket, then calls real invitation, catalog, speech and media endpoints. It checks three named episodes twice and records every fixture transcription. Its player adapter does not produce device playback. Without `--audio`, it is only an injected-text integration check.

## Phone acceptance still required

Run Brian Halligan, Benedict Evans and Andrew Ambrosino from the home screen. Try a short pause after the greeting, a reply starting before the greeting ends, and a combined wake/request. Verify visible text, audible confirmation, correct episode audio and actual playback-driven transition. Repeat with speaker and headphones, and after background/foreground. Do not call this device-accepted based on unit tests or generated fixtures.

## October 6 results

- Four original controller regressions failed before the fix; all four pass afterward. The failing tests are preserved in the preceding git commit.
- 257 app tests, type checking and lint passed.
- 35 backend tests passed.
- All 56 controller tests passed on each of five repeated runs.
- Injected-text integration: six of six episode selections passed.
- Live generated-PCM integration after catalog hints: six of six passed, three guests twice; six distinct generated invitations, empty silence transcripts, correct episode selection, speech/media bytes and simulated playback handoff. Earlier failing runs are described above, not counted as passes.
- Final iOS JavaScript export passed. This is not a signed native build or simulator run.
- Independent code review found and prompted fixes for canceled-speech echo expiry, bounded utterance storage and queued-reply ordering, then reported no scoped blocker. Manual added-comments/suppressions review found none.
- Simulator access is blocked on this Mac because Apple's simulator utility is unavailable. No physical-phone microphone, speaker or transition pass was obtained.
