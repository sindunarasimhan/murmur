# Intro skipping prototype

Scope: the prepared Brian Halligan episode, not automatic intro detection for arbitrary podcasts.

Jev interprets requests to bypass the opening and reach the main interview. There is no intro-command phrase regex. The catalog routes current-episode requests to the listening interpreter; the interpreter requires both a confident skip-intro action and introduction target. Playback code independently validates the stored boundary against the recording version and duration. Missing or stale metadata does not authorize a seek.

## Boundary evidence

Audio SHA-256: `5d55b98600573b347a83c80f180ed22ff30032f05f897fa4a53206d4cf0e8303`.

The timestamped transcript places the first substantive host question in the segment starting at 244 seconds. A 30-second clip extracted from this exact local recording at 238 seconds was transcribed with word timestamps. The greeting ends around 245.14 seconds; the question begins around 245.52 seconds. The stored target is 245.3 seconds, in that gap. This is machine-assisted audio alignment, not a claim of human listening validation. No publisher audio or transcript is committed.

## Behavior and verification

- Skip forward only while before the intro boundary; repeated requests cannot rewind.
- Preserve playing versus explicitly paused state.
- Require device seek acknowledgement before confirmation or resuming.
- Reuse playback-clock captions after seeking.
- Fail closed for unknown, stale, invalid or remote-only recordings.
- `node --import tsx scripts/evaluate-intro.mts` exercises live catalog routing, Jev decisions, playback actions and acknowledgements, with three rounds of eight positive and negative cases.
- Unit tests cover marker validity, boundary edges and controller handoff in both playback states.

Phone audio, wake detection and perceptual transition quality still require a device acceptance run. Automated service tests do not exercise those.
