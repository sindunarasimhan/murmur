# Murmur Engineering Instructions

## Conservative change policy

- Preserve working behavior. Make the smallest change needed for the explicitly requested feature or fix; do not bundle cleanup, refactors, or unrelated improvements.
- Before editing, identify the exact affected paths and establish a reproducible baseline. Keep a recoverable version-control checkpoint of the working implementation; never overwrite unrelated user changes.
- Prefer additive, isolated modules over changes to shared conversation, microphone, audio-session, navigation, and playback code.
- If changing shared behavior is genuinely necessary, explain the dependency and regression risk to the user and obtain explicit agreement before expanding the change. Do not treat a broad feature request as permission for an unrelated rewrite.
- Add targeted regression tests and rerun the working home-to-playback, voice, pause/resume, seeking, and background flows relevant to the change. Distinguish mocks, generated audio, simulator execution, and physical-device verification.
- Report precisely what changed and what was verified. Passing component tests does not establish end-to-end device success. Do not call an unverified experience complete.
- Backlog entries remain deferred until the user explicitly authorizes work on them. When asked to stop or discuss first, stop implementation and delegated edits immediately.

