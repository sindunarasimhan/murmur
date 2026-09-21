# Murmur Dev Plan

> Annotation doc for engineering execution. Keep notes concrete: what must work, how to validate it, and what blocks shipping.

## Backend rewrite — September 19, 2026

The six API routes now share bounded transport, cancellation, safe provider errors, and server configuration. Speech, transcription, Realtime credentials, answers, and directory/feed access use separate provider adapters. Jev optionally classifies inquiry intent and complexity; uncertain or unavailable decisions retain the standard OpenAI answer path. Playback actions and verified ad skipping remain deterministic. See `BACKEND.md` for the architecture and budgets.

TypeSafe is configured locally and its eight synthetic evaluation cases passed. A fresh OpenAI key and available API credits are required for live OpenAI verification after the old keys were revoked. User accounts, saved history, public-deployment authentication/rate limiting, and external fact retrieval remain future work.

## 1. Current build state

Murmur is an Expo/React Native app targeting web and iPhone through Expo Go/dev builds.

Implemented foundation:

- Expo Router app structure.
- Premium homepage and listening surfaces.
- RSS ingestion for podcast episodes.
- Production voice discovery through Apple Podcasts search and canonical publisher RSS feeds.
- Podcasting 2.0 transcript discovery.
- Timed transcript parsing for contextual questions.
- Audio playback and position tracking.
- Voice intent routing.
- Verified ad marker skip for the demo episode.
- Server-minted short-lived OpenAI Realtime sessions, contextual responses, and TTS.
- Foreground “Hey Murmur” detection during active playback using a rolling OpenAI Realtime transcription window.
- Local `.env.local` OpenAI configuration for development.

## 2. Dev principles

- Keep one shared product foundation for iPhone and web.
- Do not expose server secrets to the client.
- Use API routes as the voice/LLM boundary.
- Fail closed on ad skipping when verified markers are missing.
- Keep typed/freeform request input out of the product.
- Validate every change on both the server route and the user-visible app path.

## 3. Voice backend

Current API routes:

- `GET /api/voice-capabilities`
- `POST /api/realtime-token`
- `POST /api/podcast-search`
- `POST /api/explore`
- `POST /api/speech`

Local server config:

- `OPENAI_API_KEY`
- `OPENAI_RESPONSE_MODEL`
- `OPENAI_REALTIME_TRANSCRIBE_MODEL`
- `OPENAI_TRANSCRIBE_MODEL`
- `OPENAI_SPEECH_MODEL`
- `OPENAI_SPEECH_VOICE`
- `EXPO_PUBLIC_MURMUR_WAKE_WORD=off` only as an optional development escape hatch.
- `EXPO_PUBLIC_API_URL` only when native builds need a deployed API root.

### Voice interaction architecture

Voice mode begins from the orb or, while an episode is actively playing in the foreground, from the exact phrase “Hey Murmur.” When the user taps the orb, the app should immediately:

1. Pause or preserve the current audio context as needed.
2. Open microphone capture.
3. Request a short-lived Realtime client secret from the Murmur backend.
4. Show the listening state.
5. Stream 24 kHz PCM audio directly to OpenAI Realtime.
6. Show transcript deltas as speech arrives, then commit the turn after local silence detection or a second tap.

The primary voice path must never wait for a completed recording or upload a microphone file. The long-lived OpenAI API key remains server-only; the client receives only an expiring Realtime secret.

Realtime startup retries one transient token, socket, or browser microphone-busy failure with a fresh session. Permission denial and permanent configuration failures do not retry and must remain explicit, actionable states.

During active foreground playback, wake monitoring streams microphone PCM through a separate short-lived Realtime transcription session. Non-wake text is discarded from app state, the uncommitted input buffer is cleared on a short rolling interval, and only the complete phrase “Hey Murmur” activates the question flow. On activation, Murmur pauses immediately, saves the playback timestamp, moves the live capture into the normal episode voice session, and carries any words after the wake phrase into the request. If the listener says only the wake phrase, Murmur continues listening for the question. Tap-to-ask remains available as a fallback. The prototype does not claim background, lock-screen, or on-device keyword detection.

The interaction should not require a typed fallback. If voice is unavailable, the app should clearly explain whether the failure is microphone permission, network reachability, missing backend configuration, or transcription failure.

### Production podcast discovery

When local episode matching fails, Murmur sends the completed voice transcript to `/api/podcast-search`. The server extracts a show/title/topic query, searches the U.S. Apple Podcasts directory, rejects weak adjacent-title matches, validates the returned HTTPS feed URL, loads the canonical publisher RSS feed, and selects the newest or most relevant episode. The client receives normalized episode metadata and hands it directly to the existing player.

Directory lookup and feed loading stay server-side to avoid client CORS failures and to enforce request, redirect, URL, timeout, and response-size limits. The decorative Home artwork is not treated as the searchable catalog.

If a playable feed does not publish a usable timed transcript, Murmur may still answer general or conceptual follow-ups from the episode title, publisher description, prior turns, and general model knowledge. It must label that boundary internally and must not claim or quote what was said at the current playback moment. Exact-moment questions remain unavailable until timed context exists.

### Transcription surfaces

There are two transcript types, and they should be handled separately:

- **User transcript:** what the listener says. This may appear in a section below the orb or in a dedicated listening-state area, depending on the final design spec.
- **Murmur/system transcript:** what Murmur answers. This can appear inside the orb, but must be capped to two visible lines.

Engineering requirements:

- Keep raw transcript state separate from display-clamped transcript text.
- Preserve the full transcript for intent routing and LLM context.
- Clamp only the visual presentation.
- Animate transcript arrival so the listener understands the system is hearing, processing, or responding.
- Never treat transcript text as a typed input affordance.

### Podcast playback state

When an RSS episode is playing, the app should show a clear “podcast is active” motion state.

Required behavior:

- Load podcast metadata and audio from RSS.
- Prefer episode-level RSS transcript entries when available.
- Track playback position continuously.
- Preserve current timestamp when the listener interrupts.
- Show playback animation while the publisher stream is active.
- Stop or duck publisher audio before Murmur listens or speaks.

The screen design for this playback state belongs in `DESIGN_PLAN.md`; this section only defines engineering behavior.

### Voice ingress during playback

During an active podcast stream, the only natural-language ingress should be voice.

Required behavior:

- The listener taps the voice ingress or says “Hey Murmur” while playback is active.
- Podcast playback pauses at the current timestamp.
- Microphone capture starts.
- User transcript appears.
- Intent routing decides whether this is an action or a question.
- The app either performs the action or enters the clarification/exploration loop.
- Speech without the complete wake phrase must not interrupt playback.
- Words spoken after “Hey Murmur” must be preserved as the beginning of the request.

No additional freeform text control should be introduced for this flow.

### Skip-ad feature

First core feature to harden.

Required behavior:

1. User plays an RSS-backed episode.
2. App knows the current playback position and exact delivered audio asset.
3. User interrupts by voice and says a skip-ad intent.
4. App resolves whether the current position falls inside a verified ad/sponsored segment.
5. If verified, app seeks to the segment end.
6. App plays a short chime/ping or other completion cue.
7. Podcast playback resumes immediately after the skipped segment.

Fail-closed behavior:

- Do not guess ad boundaries.
- Do not blindly jump 30 seconds.
- Do not skip editorial content if no verified marker applies.
- If the ad segment cannot be verified, explain briefly and leave the listener in control.

Future work:

- Investigate how to detect or ingest inline ad markers from RSS, transcript timing, publisher metadata, or approved third-party data.
- For the prototype, keep the deterministic Handoff demo marker as the controlled validation fixture.

### Clarify / explain / return feature

Second core feature to harden.

Required behavior:

1. User interrupts mid-stream by voice.
2. Podcast pauses and timestamp is saved.
3. User asks a clarifying question, factual question, debate prompt, or abstract follow-up.
4. App assembles context from:
   - episode metadata,
   - current timestamp,
   - nearby transcript window,
   - prior Murmur dialogue,
   - playback state.
5. Backend asks the LLM for a proportional answer.
6. Murmur speaks the answer in its distinct AI voice.
7. Murmur/system transcript appears in the answer surface.
8. User can ask follow-ups or return to the episode.
9. On return, podcast resumes at the preserved timestamp unless the user requested a seek.

Response policy:

- Actions should be short and mostly silent.
- Concept explanations can be more detailed.
- Quantifiable or factual questions should expose assumptions and uncertainty.
- Debate/counterargument prompts should compare reasoning clearly.
- Philosophical or abstract prompts can go deeper while staying anchored to the episode.

### Voice validation checklist

- [x] Server reports transcription ready.
- [x] Server mints a scoped, short-lived Realtime client secret without exposing the API key.
- [x] A real PCM stream returns transcript deltas/final text through OpenAI Realtime.
- [x] Direct OpenAI speech call returns audio.
- [x] Murmur `/api/speech` returns MP3 with `ai-generated` disclosure.
- [ ] Expo Go mic permission flow succeeds on device.
- [ ] Expo Go streams microphone PCM to the Realtime socket.
- [ ] User transcript appears during capture.
- [ ] Murmur/system transcript appears during response and is visually clamped to two lines when inside the orb.
- [x] Local and production directory search routes “Play [podcast/episode]” to a live RSS episode.
- [ ] “Skip ad” lands after the verified sponsored segment.
- [ ] Skip completion plays a chime/ping and resumes the podcast.
- [ ] User can ask a clarification and hear Murmur respond.
- [ ] User can return to the episode at the preserved timestamp.
- [ ] During active foreground playback, “Hey Murmur” pauses at the current timestamp and opens the same live question surface.
- [ ] Speech without “Hey Murmur” does not interrupt playback.

## 4. Immediate dev priorities

### P0 — ship-today prototype

1. Confirm Expo Go can reach the LAN API root.
2. Confirm microphone permission and live PCM streaming work on iPhone.
3. Confirm transcript deltas appear while the user is still speaking.
4. Confirm orb tap immediately starts voice mode when backend is ready.
5. Confirm homepage voice state progression:
   - resting
   - listening
   - transcribing
   - processing
   - action/answer
6. Confirm user transcript displays during capture.
7. Confirm Murmur/system transcript displays during response with two-line clamp where applicable.
8. Confirm RSS-backed podcast playback shows active playback motion.
9. Confirm local and arbitrary production “play specific podcast/episode” voice selection.
10. Confirm “skip ad” on the controlled Handoff demo.
11. Confirm skip completion cue and automatic resume.
12. Confirm a simple contextual question flow.
13. Confirm return-to-podcast resumes from the preserved timestamp.
14. Confirm “Hey Murmur” interrupts active playback, preserves trailing request words, and leaves tap-to-ask working.

### P1 — design fidelity

1. Tighten homepage artwork grid to match the supplied reference.
2. Improve smokey glass orb motion and readability.
3. Polish detail page layout into a real listening surface.
4. Standardize voice takeover across discovery and detail.
5. Remove leftover prototype copy.

### P2 — production hardening

1. Move API routes to a deployed server/API host.
2. Add production auth/rate limiting.
3. Add catalog rights/metadata governance on top of the implemented directory/RSS discovery pipeline.
4. Add telemetry for voice success/failure states.
5. Add crash/error reporting.
6. Add EAS build/deployment workflow.

## 5. Known technical risks

- Expo Go may expose a different dev host than the phone can reach.
- iOS microphone permissions can remain denied until changed in Settings.
- Browser and iPhone use different PCM capture APIs even though both feed the same Realtime protocol.
- Plain HTTP LAN pages and embedded previews may not expose `getUserMedia`; web microphone QA must use localhost or HTTPS, while Expo Go uses native capture over the LAN development connection.
- `gpt-live-transcribe` currently requires client-side turn completion; Murmur uses local silence detection plus tap-to-finish.
- The Expo Go prototype performs foreground wake detection through cloud transcription. Production should move keyword spotting on-device to reduce network, privacy, battery, and continuous-stream cost concerns.
- OpenAI keys and credits are project/org specific.
- RSS transcripts may be missing, untimed, or legally unusable for launch.
- Exact ad skipping requires verified markers tied to the delivered audio asset.

## 6. Test commands

```sh
npm run check
```

```sh
curl -sS -H 'X-Murmur-Client: expo' \
  -H 'Accept: application/json' \
  http://192.168.1.218:8081/api/voice-capabilities
```

Expected:

```json
{"transcription":"ready"}
```

Realtime session smoke test:

```sh
curl -sS -X POST \
  -H 'X-Murmur-Client: expo' \
  -H 'Content-Type: application/json' \
  --data '{"surface":"discovery"}' \
  http://192.168.1.218:8081/api/realtime-token
```

Expected: `200 OK` with an `ek_…` short-lived client secret, model `gpt-live-transcribe`, and sample rate `24000`. Never log or persist the returned secret.

## 7. Manual device QA script

1. Open Expo Go with the current LAN URL.
2. Confirm homepage loads into resting orb state.
3. Tap the orb.
4. Allow microphone permission if prompted.
5. Say: “Play The Handoff Test.”
6. Confirm playback starts.
7. Tap voice again during the sponsored segment.
8. Say: “Skip ad.”
9. Confirm playback jumps to the content boundary.
10. Tap voice again and ask: “What does handoff mean here?”
11. Confirm transcript appears, Murmur answers, and return/resume works.

## 8. Definition of done for today

- Device voice no longer shows unavailable when backend is ready.
- User speech is transcribed and visible.
- Handoff demo can be selected by voice.
- Sponsored segment skip is obvious and deterministic.
- One contextual explanation works end-to-end.
- Latest code/docs are committed and pushed.
