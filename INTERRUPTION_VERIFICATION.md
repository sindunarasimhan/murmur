# Playback interruption: unresolved device acceptance

Clean generated speech is insufficient acceptance for speaker playback. The new `--audio --overlap` exploration check mixes a second generated voice into the microphone fixture while playback is active, then removes it when the controller pauses. Set `MURMUR_TEST_BACKGROUND_GAIN` from 0 to 2; default 0.3. This is a controlled PCM mixture, not a recording of the phone's acoustic path.

Observed September 27:

- At gain 0.3, the first interruption and three-answer return loop passed. The second interruption remained in playback; its final transcription did not contain the wake phrase.
- At gain 1, the first interruption remained in playback; its final transcription did not contain the wake phrase.
- These failures reproduce a recognition weakness under overlapping speech. They do not establish the cause on the user's phone without knowing the output route or observing that attempt.
- The installed Expo Audio iOS stream creates a recording/measurement session and an input tap. Its public stream options expose format and callback settings, not acoustic echo cancellation or voice processing. Changing the installed Swift file does not change Expo Go on a user's phone.

Development server diagnostics record connection IDs, input byte totals, transcript length and wake-present flags, and connection failures. They do not record speech text or microphone audio. Production logging is disabled. No phone attempt has yet been identified in these diagnostics.

Next acceptance needs an actual foreground phone attempt with output route known. For speaker use, investigate echo-cancelled duplex audio in an Expo development build; do not claim that route fixed without audible device testing. Switching away from Expo Go requires user agreement. Preserve the current working playback path meanwhile.
