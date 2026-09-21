# Murmur Acceptance and Evals Plan

> Annotation doc for deciding whether Murmur is good enough to ship. Acceptance is pass/fail product behavior. Evals measure quality over repeated examples.

## 1. Ship-today acceptance criteria

Murmur is acceptable for the current prototype only if all P0 criteria pass on iPhone through Expo Go.

### P0 acceptance

- [ ] App opens from Expo Go without a blank screen.
- [ ] Homepage matches the intended voice-first structure: brand, settings, orb, animated artwork field.
- [ ] Resting orb is visible and subtly alive.
- [ ] Tapping the orb opens microphone capture.
- [ ] “Voice unavailable” does not appear when the backend readiness endpoint returns `ready`.
- [ ] User speech is transcribed live and shown in the dedicated two-line area below the orb.
- [ ] Transcript is limited to two lines.
- [ ] User can ask Murmur to play `The Handoff Test`.
- [ ] User can name a podcast outside the preloaded artwork catalog and Murmur resolves a live RSS episode.
- [ ] Handoff demo playback works.
- [ ] During active playback, “Hey Murmur” pauses at the interruption timestamp and opens the live question surface.
- [ ] Speech without the complete wake phrase does not interrupt playback.
- [ ] “Skip ad” during the verified sponsored segment lands after the ad.
- [ ] Murmur does not guess a skip when no verified segment applies.
- [ ] User can ask one contextual question and receive a useful spoken answer.
- [ ] Podcast audio and Murmur AI speech do not overlap.
- [ ] The user can return to the episode after Murmur answers.

### P1 acceptance

- [ ] Background cover rows animate continuously and smoothly.
- [ ] Adjacent rows scroll in opposite directions.
- [ ] Covers are large enough to read as premium artwork.
- [ ] Orb feels like smokey glass, not generic particles.
- [ ] Detail page layout looks intentionally designed.
- [ ] Buttons are aligned and sized consistently.
- [ ] No keyboard/freeform typed request path is visible.
- [ ] Error states give clear retry/settings/cancel paths.

## 2. Voice intent evals

Evaluate whether Murmur routes spoken requests correctly.

| Eval type | Example | Expected behavior |
|---|---|---|
| Play exact episode | “Play The Handoff Test.” | Opens/plays Handoff demo |
| Play arbitrary show | “Play the latest episode of The Daily.” | Searches the production directory, loads RSS, and plays the newest episode |
| Resolve official show | “Joe Rogan podcast.” | Opens `The Joe Rogan Experience` by `Joe Rogan`; never substitutes an adjacent or impersonator feed |
| Play by topic | “Find a podcast about artificial intelligence.” | Resolves a relevant show and playable RSS episode |
| Skip ad | “Skip this ad.” | Skips only if current timestamp is inside verified ad marker |
| No false skip | “Why do podcasts have ads?” | Treats as question, does not skip |
| Pause/resume | “Pause this.” / “Resume.” | Performs playback action |
| Wake + question | “Hey Murmur, what did that mean?” during playback | Pauses immediately, removes the wake phrase from visible text, and routes the trailing question |
| Wake only | “Hey Murmur” during playback | Pauses and continues listening for the question |
| No false wake | “They murmur quietly” during playback | Playback continues with no voice takeover |
| Clarify | “What does that mean?” | Gives concise contextual explanation |
| Metadata-only follow-up | “Who is this guest?” on an episode without a timed transcript | Answers from episode metadata/general knowledge when possible and never pretends to quote the current moment |
| Quantify | “Do those numbers add up?” | Gives reasoned analysis with uncertainty |
| Debate | “Make the strongest case against that.” | Provides counterargument grounded in context |
| Go deep | “What does this imply?” | Allows more abstract explanation |

Pass target for prototype:

- 90%+ correct routing on the controlled demo set.
- 0 false ad skips in the controlled demo set.

## 3. Transcription evals

Evaluate actual user speech, not typed substitutes.

Test utterances:

- “Play The Handoff Test.”
- “Skip ad.”
- “What does handoff mean here?”
- “Go deeper on that.”
- “Resume the episode.”

Acceptance:

- Transcript is non-empty.
- Transcript appears in the UI.
- Transcript is not longer than two visible lines.
- Transcript preserves enough wording for intent routing.
- Errors explain whether the issue is permission, network, server config, or unclear audio.

## 4. Ad skip evals

Use only controlled audio with verified markers.

Acceptance:

- Skip request inside marker jumps to marker end.
- Skip request before marker does not jump to marker end unless the product explicitly supports “next ad” behavior.
- Skip request after marker does not jump backward.
- Question containing “ad” does not trigger a skip.
- Unknown/unverified episode fails closed.

## 5. Explanation quality evals

Murmur should respond proportionally.

| User intent | Good response | Bad response |
|---|---|---|
| Action | Minimal confirmation or no speech | Long explanation before acting |
| Simple clarification | Short, contextual explanation | Generic definition detached from episode |
| Complex concept | More detail with structure | Overly terse answer |
| Quantifiable claim | Reasoning, assumptions, uncertainty | Unsupported certainty |
| Debate | Strong opposing case and tradeoffs | Strawman or generic pros/cons |
| Philosophical question | Thoughtful abstraction tied to the episode | Detached chatbot answer |

Prototype pass target:

- 80%+ judged appropriate by owner review on the first controlled eval set.

## 6. Design acceptance evals

Use the supplied reference screenshots as visual targets.

Acceptance:

- Homepage composition matches reference structure.
- Artwork field reads as a premium background grid.
- Orb is the clear hero object.
- Resting/listening/transcription states are visually distinct.
- Text remains readable over motion.
- The app does not look like a default generated prototype.

Suggested eval method:

- Capture iPhone screenshots for resting, listening, transcription, detail page, and error state.
- Compare each against the design plan checklist.
- Mark exact deltas in `DESIGN_PLAN.md`.

## 7. Backend acceptance

- OpenAI key belongs to the intended project.
- Direct OpenAI speech test returns audio.
- Murmur `/api/speech` returns audio.
- Murmur `/api/voice-capabilities` returns `ready`.
- Murmur `/api/realtime-token` returns a scoped short-lived secret.
- Microphone audio is streamed as PCM; no completed recording upload is used for the primary voice path.
- API key is never committed.
- `.env.local` remains untracked.
- Old pasted keys are revoked after testing.

## 8. Final go/no-go

Go if:

- All P0 acceptance criteria pass.
- No active secret is present in git.
- Voice works on the real iPhone path.
- Skip ad and one contextual question work end-to-end.

No-go if:

- Voice unavailable persists on-device.
- Transcription fails for normal speech.
- Skip ad cannot be demonstrated.
- The app depends on typed input to complete the core flow.
- The current API key remains exposed and unrotated for anything beyond local prototype testing.
