# Clay invocation

## Completion condition

The existing Expo app opens a clay mascot screen, starts microphone capture after permission, shows live request transcription, responds with real speech, and retrieves the intended catalog episode. Foreground idle listening accepts Hey Murmur. The screen has no in-app buttons. Faded animated podcast artwork remains behind the mascot. The existing player is preserved.

Physical iPhone evidence and visual review remain required for acceptance. Automated checks, simulator evidence, and provider checks are reported separately.

## Workflow

- [x] Read the Principles section of poteto-mode.
- [x] Phase A: Frame.
- [x] Phase B: Design the workflow.
- [x] Phase C: Run the loop.
- [x] Phase D: Keep the audit trail.
- [x] Phase E: Verify and hand back with explicit device acceptance gates.

1. Trace the active routed voice system, capture baseline test results, and compare architecture candidates.
2. Extend the existing voice owner with tested foreground activation.
3. Prepare the supplied character for native facial animation. Build the clay invocation screen using the existing background rail.
4. Verify static checks, behavioral tests, native export, and runtime appearance. Probe backend readiness separately from UI tests.
5. Independently review the changed code, record unresolved gates, and push the completed implementation.

## Throughput checkpoint

- Blocking first steps: identify the active route and voice owner before editing; obtain animation-ready character artwork.
- Independent workstreams: voice lifecycle and mascot presentation use separate files.
- Shared mutable state: only the existing voice controller owns microphone and playback state. The UI reads it.
- Smallest safe decomposition: one lifecycle implementer and one UI implementer; an independent reviewer checks integration.

## Architecture decision

The current routes render LennyScreen under LennyVoiceProvider. HomeScreen and useListeningSession are legacy routes, not the entry point. Keep LennyVoiceController as the domain owner. A second invocation controller would duplicate microphone ownership, cancellation, and wake gating. New presentation maps VoiceState to facial expression and text without owning speech or requests.

The existing state model supplies idle, connecting, listening, thinking, speaking, followup, playing, paused, and error. The mascot receives that state; mouth motion follows the speaking phase, not phonemes or microphone energy. Facial animation never claims a disconnected microphone is listening. Invocation stays visible through the first retrieval and spoken selection, then hands off to the existing player when playback starts.

## Skill portability

Original pstack instructions were read from cursor/plugins. Cursor-specific Task roles, external Claude/Grok models, and control tools are unavailable in this environment. Equivalent available subagents and Expo verification are used; this is not a claim of running the installed Cursor plugin or cross-family review.

## Verification results

- Baseline: 185 unit tests passed before edits.
- Final implementation: typecheck, lint, and 195 unit tests passed.
- Backend: 29 tests passed.
- iOS Expo bundle export passed. This is not a native device run.
- Expo browser rendering inspected at 390 × 844 and 320 × 568. The small layout scrolls. Fixed missing asset sizing discovered during inspection. Permission-denied UI reports mic off and recovery instructions, not listening.
- Live OpenAI transcription: synthesized “Hey Murmur, play Lenny” sent twice through one authenticated connection; both turns returned partial text before final commit and recognized the wake phrase.
- Live catalog interpretation selected the prepared Brian Halligan episode from a natural-language request. Its correct `/v2/media` audio URL returned HTTP 206 and audio/mpeg. An initial probe omitted `/v2` and failed; corrected probe passed.
- Independent review identified and fixed stale native-start cleanup, rejected-cleanup recovery, and premature mascot-to-player handoff. Capture regression tests passed independently.
- Comment audit: zero recommended deletions, zero new suppressions, no unresolved refactor flags. Manual deslop review kept the scope to invocation and lifecycle.

## Remaining acceptance gates

Device follow-up: the first user attempt failed voice input, feedback, and playback. Metro captured an iOS exception from `player.replace(null)` during shutdown. Expo's native `replace` takes a non-null AudioSource record; an empty record clears the underlying item. Replaced the invalid argument and added a regression ensuring cleanup failure cannot mask the original startup error. Phone retry is required; this does not establish that the underlying microphone failure is resolved.

- Physical iPhone: initial permission, automatic listening, live transcript, audible response, foreground idle wake, speaker echo, and background/foreground recovery.
- User approval of the mascot and clay treatment. The image is the supplied character adapted into a faceless base with native facial overlays; it is not a fully rigged 3D asset.
- Expo Go and backend must remain reachable from the phone on the same network. This is a running local preview, not cloud deployment.
- Wake detection is foreground streaming transcription, not an offline wake-word engine. Mic audio is sent to OpenAI while waiting for the phrase. Background/locked-phone wake is not implemented.
- The preview contains the prepared Lenny episode. Replies use existing catalog-driven selection and confirmation, not a general open-ended podcast search assistant. Playback UI remains unchanged.

## Voice redesign and device-failure follow-up

- Expo players participating in the voice flow now retain the shared iOS audio session when paused. The installed native implementation otherwise deactivates it after pause even with a stream capturing.
- Startup requires a nonempty native microphone buffer before reporting listening; a stalled native capture reports an error. Permission, service connection, and capture stages appear separately.
- Disposal attempts microphone and speech cleanup even if Expo has already released the player during refresh. Regression added after the device log exposed this failure.
- Invocation uses OpenAI-only speech, including confirmations and error replies. It never silently falls back to device speech. An unavailable speech service leaves a visible error; it cannot produce an audible error when that same service is unreachable.
- Mascot speech motion follows the audio player's playing event, not the speech request. Interrupting clears that motion.
- Latest verification: typecheck/lint and 200 unit tests pass; iOS export passes. `scripts/smoke-invocation.mts` passed two consecutive live turns through transcription, catalog selection, session creation, episode audio retrieval, actual OpenAI speech bytes, and controller playback handoff. Native capture and audible playback are not substituted for acceptance: the user must verify these on the phone.

## Mascot asset provenance

Source: user-supplied cream clay mascot wearing sage headphones. Generated with the imagegen tool and copied to `assets/images/murmur-mascot-base.png`.

Edit specification: preserve the exact silhouette, body, head tilt, clay texture, cream color, sage headphones and cheek tint; remove only eyes, brows and mouth, replacing those regions with seamless clay; transparent alpha, full mascot with approximately five percent margin, no text. Native eye, pupil, brow and mouth layers supply expression.
