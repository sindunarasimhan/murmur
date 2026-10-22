# Conversation while listening

## Plan

- Ground. Trace wake capture, turn routing, transcript retrieval and bookmark ownership.
- Sketch. Compare a typed engagement policy inside the current controller with a separate conversation controller.
- Agree. Choose after independent review. No new wake-free microphone behavior during podcast playback.
- Implement. Delegate the controller change with behavior tests. Keep UI and service edits in disjoint files.
- Scrap. Revisit the design if preserving the bookmark requires duplicated ownership.
- Verify. Run controller regressions, live multi-turn service checks, UI inspection and the iOS export. Report phone-only checks separately.
- Review. Inspect the diff and comments before committing and pushing.

## Throughput checkpoint

- Blocking first steps. Read the existing changes and trace the live pipeline before editing it.
- Independent workstreams. The controller owner handles engagement state and tests. The lead handles service grounding and display text. A fresh reviewer checks the combined diff.
- Shared mutable state. The current controller and repository retain bookmark ownership. Agents do not edit the same files. Existing README and player text edits are preserved.
- Smallest safe decomposition. One controller owner avoids concurrent changes to cancellation and timers. The UI has no separate playback state owner.

## Acceptance

An interruption pauses before answering. Questions and multiple follow-ups preserve the saved position. Silence never resumes an active exploration. A natural-language return resumes once at that position. New episode selection ends the previous exploration. Delayed replies cannot restart cancelled audio. Episode passages and broader explanation are distinguished. Missing evidence produces an honest limitation rather than an invented quotation.

The screen keeps microphone status, one short phase label, the listener's live words, the spoken answer and playback captions where relevant. Promotional copy and repeated guidance are removed. The cloud microphone disclosure stays available on the start screen.

## Tooling limits

The pstack Feature, How, Architect, Model the Domain, Prove It Works, Unslop and No Comments instructions were read. Cursor-specific agent classes and model presets are unavailable. Available Codex agents provide implementation and independent review. No claim of cross-family Cursor verification is made. Work stays in the existing user checkout and branch to preserve ongoing changes. No destructive worktree resets or PR readiness changes are authorized.

## Design decision

Keep engagement as a typed state in the existing voice controller rather than add a second conversation controller. This keeps microphone, cancellation and bookmark ownership together. Episode dialogue remains open during silence. Explicit playback actions clear dialogue history. During podcast or assistant audio, a wake phrase is still required; after an answer, ordinary follow-ups are accepted.

Retrieval retains prior episode evidence only for the same session, recording and bookmark. Generated examples must be labeled hypothetical. A contextual “continue” goes through intent interpretation rather than the exact playback shortcut.

## Verification findings

The first live text run passed three answers and exact resume at two bookmarks. Generated audio then exposed a premature transcription commit after an input gap: the buffer measured elapsed time from the previous commit instead of its first new audio. The fix includes a deterministic 20-second-gap regression. The failed run was not accepted as a pass.

The live script uses the real controller, backend, intent service and generated speech. Audio mode also uses real transcription. Its player and microphone adapters are test substitutes; it does not certify phone acoustics, the listener's accent, background operation or audible Expo playback. UI inspection used browser fixtures for idle, playing and speaking; the temporary route was removed. Phone acceptance remains separate.

## Results and remaining acceptance

- Typecheck, lint, 225 app tests, 33 backend tests and iOS export passed.
- Live text exploration passed twice, each at two bookmarks with three answers and an exact return.
- After the buffer fix, generated speech passed both three-answer conversations and exact return through real transcription and output speech.
- Lenny routing, ad skipping and grounded-answer regression passed. Intro regression hit one provider 503, then passed all 24 cases on retry.
- Independent review passed controller and transport behavior. It flagged illustrative examples being partly attributed to the episode. The final instruction now requires hypothetical framing from the first sentence; the live script asserts that framing.
- The final wording rerun could not start: identity creation returned HTTP 429 after repeated disposable test accounts. Limits were not increased. The final prompt passed typecheck/backend tests but its generated wording remains unverified. This is not full phone acceptance or a claim of unrestricted answer accuracy.

To rerun when account creation is available: `node --import tsx scripts/evaluate-exploration.mts`; add `--audio` and set `FFMPEG_PATH` for generated-speech input. Do not use a real listener's account for destructive test cleanup.
