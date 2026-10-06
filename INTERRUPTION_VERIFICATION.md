# Playback interruption: unresolved device acceptance

Clean generated speech is insufficient acceptance for speaker playback. The new `--audio --overlap` exploration check mixes a second generated voice into the microphone fixture while playback is active, then removes it when the controller pauses. Set `MURMUR_TEST_BACKGROUND_GAIN` from 0 to 2; default 0.3. This is a controlled PCM mixture, not a recording of the phone's acoustic path.

Observed September 27:

- At gain 0.3, the first interruption and three-answer return loop passed. The second interruption remained in playback; its final transcription did not contain the wake phrase.
- At gain 1, the first interruption remained in playback; its final transcription did not contain the wake phrase.
- These failures reproduce a recognition weakness under overlapping speech. They do not establish the cause on the user's phone without knowing the output route or observing that attempt.
- The installed Expo Audio iOS stream creates a recording/measurement session and an input tap. Its public stream options expose format and callback settings, not acoustic echo cancellation or voice processing. Changing the installed Swift file does not change Expo Go on a user's phone.

Development server diagnostics record connection IDs, input byte totals, transcript length and wake-present flags, and connection failures. They do not record speech text or microphone audio. Production logging is disabled. No phone attempt has yet been identified in these diagnostics.

Next acceptance needs an actual foreground phone attempt with output route known. For speaker use, investigate echo-cancelled duplex audio in an Expo development build; do not claim that route fixed without audible device testing. Switching away from Expo Go requires user agreement. Preserve the current working playback path meanwhile.

## October 6: foreground voice / background playback boundary

Implemented, not device-accepted:

- Backgrounding suspends microphone transport, capture, pending questions, and assistant speech without clearing or deliberately pausing the episode player.
- Background playback is enabled in the Expo audio plugin and runtime mode; background recording remains disabled. Config introspection produces iOS `UIBackgroundModes: ["audio"]`.
- The episode owns Now Playing metadata and play/pause/seek controls. Clearing an episode clears its system controls.
- Returning to the foreground reconnects voice without loading or seeking the episode. Native player state takes precedence over a stale conversation bookmark before the next request.
- Audio-session transitions restore playing state when microphone setup/cleanup disrupts it. Cancelled generations cannot restore stale playback.
- Voice failures retain the episode and its position. Background episode completion is silent.

Verification: typecheck and lint passed; 239 app tests and 35 backend tests passed; 50 controller/lifecycle/audio-handoff tests passed on each of five repetitions; iOS JavaScript export passed. Existing development server and backend health checks passed. These are software checks, not a physical microphone, speaker, or iOS system-control test.

Device acceptance still required on a rebuilt, signed Expo app (native plugin settings are not delivered by a JavaScript reload):

1. Play an episode, leave for the Home Screen, then lock the phone. Confirm uninterrupted audible playback and no microphone use.
2. Verify title/artwork and play, pause, seek forward/back in Lock Screen / Control Center. Leave audio playing for several minutes.
3. Reopen while playing, then while paused. Confirm the actual current position and playback state survive, with no reload or jump to the start.
4. Say “Hey Murmur” after reopening, ask a question, then return to the podcast. Confirm the new interruption position is used, not an earlier bookmark.
5. Background during an answer and during voice startup. Confirm no delayed speech or capture; repeat rapid app switches.
6. Test speaker, headphones, disconnecting headphones, and unavailable voice service. Confirm a voice failure does not clear playback.

No signed installable phone build was produced in this task. Signing/account setup is not established in the project; the existing Expo Go installation cannot validate newly generated native configuration. Persistent recovery after force-quit, a Home Screen widget, background voice questions, and best-effort unknown-ad detection are outside this change.
