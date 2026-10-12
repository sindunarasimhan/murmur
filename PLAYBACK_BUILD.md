# Playback prototype

## Plan and verification gates

1. Ground the existing playback, transcript, and ad-skip paths.
2. Compare route replacement with a single animated composition.
3. Implement timed captions, playback composition, and audio-driven mouth movement.
4. Test interruption, exact ad end, outside-ad requests, replayed commands, caption boundaries, and failure behavior.
5. Inspect the actual Expo layout and run live backend checks. Keep physical phone validation distinct.
6. Review, commit, push, and verify the remote commit.

## Throughput checkpoint

- Blocking first steps. Confirm the prepared recording's transcript and version-bound ad metadata.
- Independent workstreams. UI agent owns presentation and caption selection. Root owns transcript API, voice amplitude, integration, and verification.
- Shared mutable state. Existing voice controller remains the sole playback and microphone coordinator. UI is a read-only projection.
- Smallest safe decomposition. Two code owners with disjoint files. Root reviews the assembled feature.

## Design

The prepared Brian Halligan recording has timed transcript segments and an audio-reviewed ad from 2230 to 2290 seconds. Skip decisions remain server-side and bound to the recording's audio version.

Route replacement remounts the mascot and can flash the old dark screen. A single clay composition moves the existing mascot upward and reveals artwork/captions without replacing the voice owner. This is the selected design.

Data shapes are a versioned caption track containing timed cues, existing VoiceState, and normalized assistant speech energy. Sentence-level timing can be subdivided for short captions but is not word alignment. No synthetic transcript or arbitrary ad jump is introduced.

Pstack portability remains as documented in INVOCATION_BUILD.md. External Cursor model roles are unavailable. Model the Domain keeps timing and skip boundaries explicit; Prove It Works keeps phone acceptance open until exercised on the phone.

## Verification

- Typecheck, lint, and 207 unit tests passed. Backend tests passed 30 cases including authenticated, version-bound caption requests.
- Live Lenny evaluation passed catalog requests, start/end ad boundaries, repeated skips, paused skips, grounded answer, speech generation, and saved position.
- The first LAN caption check failed because the Expo proxy discarded the query string. Fixed the proxy, added a regression, and repeated the actual phone-facing request successfully. It returned 236 timed cues for the matching recording.
- iOS bundle export passed.
- Visual fixture inspected at 390 × 844 and 320 × 568. Mascot, artwork, progress and two-line captions fit; temporary preview route removed. Browser audio autoplay was denied, so browser inspection provides visual evidence only.
- Mouth movement now follows sampled speech amplitude where audio sampling is supported. Unsupported sampling leaves a relaxed mouth rather than pretending to provide lip sync.
- Same-screen composition removes the route remount. Exact smoothness, speaker echo, live captions and ad seeking on the phone still require device acceptance.
- Independent review corrected the wake-prefixed skip hint, empty-caption status, and the heading's fixed-height accessibility clipping. No introduced comment or suppression findings remained.
- Repeated live invocation still passes both turns with real OpenAI speech bytes after these changes.

## Phone acceptance sequence

1. Open Murmur and say “Play Lenny.” Check the mascot moves up, artwork appears and captions follow playback.
2. Say “Hey Murmur,” then “jump to thirty seven minutes.” This seeks just before the reviewed ad.
3. When the ad starts, say “Hey Murmur, skip this ad.” Expect the playback position to reach 38:10 and resume the interview.
4. Repeat outside the ad. Expect an honest no-ad response with no second jump.
5. Check a pause, interruption during Murmur speech, and foreground return. No recording should be claimed active without incoming audio.
