# Murmur Test Plan

> Annotation doc for QA. Use this to capture what must be tested manually, automatically, and on-device before a build is trusted.

## Backend rewrite checks — September 19, 2026

- Automated regressions cover provider deadlines through the body, cancellation before and during calls, bounded payloads, malformed/expired Realtime secrets, distinct credential/credit failures, conservative Jev routing and fallback, and blocked RSS redirects.
- The live TypeSafe smoke evaluation passed 8/8 synthetic label pairs (72–276 ms on this run). This does not establish accuracy on real listener traffic or justify enabling a smaller answer model.
- `npm run check` passed type checking, lint, and all 168 tests. `npm run export:web` passed for the client and all six server routes. A scan of 36 exported client files found neither configured credential.
- The running local server rejected unidentified calls on all six routes with 403/no-store. Live Apple directory + RSS discovery returned The Daily and a playable episode in 724 ms.
- Live OpenAI speech/answer checks require a replacement key and available credits. Physical iPhone microphone, wake phrase, and playback QA has not been repeated for this server rewrite.

## 1. Test goals

- Test what has actually been implemented before telling the owner it is ready to test.
- Use `DEV_PLAN.md` as the engineering behavior source of truth.
- Use `DESIGN_PLAN.md` as the visual and interaction source of truth.
- Use `APP_PLAN.md` only when the detailed plans are unclear or incomplete.
- Separate implemented-flow testing from future-scope testing so unfinished features are not accidentally treated as regressions.
- Catch both functional failures and design-quality regressions before handoff.

## 2. Testing rule going forward

Every implemented slice must pass three gates before handoff:

1. **Dev behavior gate:** Does it do what `DEV_PLAN.md` says it should do?
2. **Design behavior gate:** Does it look, move, and communicate state the way `DESIGN_PLAN.md` says it should?
3. **User-flow gate:** Can a user complete the intended flow without hidden knowledge, stale state, typed fallbacks, or developer intervention?

Do not say “you can test it” until the implemented slice has been checked against the relevant sections of `DEV_PLAN.md` and `DESIGN_PLAN.md`.

If a requirement appears in the plan but is not implemented yet, mark it as **not implemented** rather than failed. If a requirement is implemented but broken, mark it as **failed** and fix before handoff.

## 3. Test environments

| Environment | Purpose | Status |
|---|---|---|
| Local web, `localhost:8081` | Fast layout/API smoke checks | Required |
| Expo Go on iPhone, LAN URL | Primary prototype test path | Required |
| Native dev build | Future production-like native QA | Later |
| Deployed API host | Future external-device QA | Later |

Do not use a plain `http://192.168…` browser page for microphone QA. Browser voice requires localhost or HTTPS. Embedded preview browsers that omit `getUserMedia` can validate layout and error recovery only; use Expo Go for the physical iPhone voice pass.

## 4. Plan traceability

Use this matrix before QA on any slice.

| Implemented slice | Dev plan reference | Design plan reference | Required test type |
|---|---|---|---|
| Homepage orb/resting state | Voice interaction architecture | Homepage direction, central orb | Visual + motion |
| Voice activation from orb | Voice backend, voice interaction architecture | Voice states, transcription state | Device + backend |
| User transcription | Transcription surfaces | Transcription state | Device + UI |
| Murmur/system response | Clarify / explain / return feature | System response state | Backend + UI + audio |
| RSS episode playback | Podcast playback state | Playback surface | Playback + visual |
| Production podcast search | Production podcast discovery | Voice states | Backend + voice + playback |
| Voice interruption during playback | Voice ingress during playback | Voice interruption pattern | Device + playback |
| “Hey Murmur” foreground wake phrase | Voice ingress during playback | Voice interruption pattern | Device + playback + negative cases |
| Skip ad | Skip-ad feature | Skip-ad interaction | Functional + audio cue |
| Clarifying question loop | Clarify / explain / return feature | In-stream question interaction | Functional + response quality |
| Contextual recommendations/welcome | Voice interaction architecture, future persistence work | Context and personalization | Product eval |

## 5. Automated checks

Run before any handoff:

```sh
npm run check
```

Coverage expected:

- TypeScript compile.
- Lint.
- Unit tests for voice routing.
- Unit tests for exact wake-phrase matching and trailing-request extraction.
- Unit tests for ad marker resolution.
- Unit tests for RSS/transcript parsing.
- Unit tests for spoken directory query parsing, show ranking, and episode selection.
- Unit tests for API client behavior.
- Unit tests for server API contracts.
- Unit tests for artwork rail motion math.

Automated checks are necessary but not sufficient. Passing unit tests does not mean the slice is ready unless the relevant manual/user-flow checks also pass.

## 6. Backend smoke tests

Voice readiness:

```sh
curl -sS -H 'X-Murmur-Client: expo' \
  -H 'Accept: application/json' \
  http://192.168.1.218:8081/api/voice-capabilities
```

Expected:

```json
{"transcription":"ready"}
```

Speech route:

- `POST /api/speech`
- Expected: `200 OK`
- Expected content type: `audio/mpeg`
- Expected header: `X-Murmur-Voice-Disclosure: ai-generated`

Realtime voice route:

- `POST /api/realtime-token` with `{ "surface": "discovery" }` or `{ "surface": "episode" }`.
- Expected: `200 OK` with a short-lived `ek_…` secret, `gpt-live-transcribe`, and `24000` sample rate.
- Open `wss://api.openai.com/v1/realtime` with that secret, append PCM chunks, and commit the turn.
- Expected: transcript delta events while audio streams and one non-empty completed transcript.
- Never log, persist, or bundle either the server API key or the short-lived secret.

Production podcast search route:

- `POST /api/podcast-search` with `{ "query": "Play the latest episode of The Daily" }`.
- Expected: `200 OK`, provider `apple-podcasts-rss`, the resolved show/feed, and one playable HTTPS episode enclosure.
- Repeat with `{ "query": "joe rogan podcast" }` and expect the verified U.S. directory result `The Joe Rogan Experience` by `Joe Rogan`, never an adjacent or AI-generated show.
- Fetch the first bytes of the enclosure with a range request and expect playable audio content.

## 7. Implemented-flow QA

Run only for flows that are actually implemented in the current slice. For each flow, record:

- `pass`
- `fail`
- `not implemented`
- `blocked`

### Flow A — homepage resting state

Source:

- `DESIGN_PLAN.md` homepage direction, central orb, current design QA checklist.

Checks:

1. Open the app.
2. Confirm the homepage shows the brand, settings affordance, orb, and dim animated artwork field.
3. Confirm no typed/freeform request input is visible.
4. Confirm the resting orb has visible internal motion.
5. Confirm background rows move horizontally.
6. Confirm adjacent rows move in opposite directions.
7. Confirm text remains readable over the orb/background.

### Flow B — homepage voice activation

1. Open the Expo Go URL.
2. Confirm homepage loads without stale “voice unavailable” state.
3. Confirm resting orb is visible.
4. Confirm internal orb motion is alive but readable.
5. Tap the orb.
6. Allow microphone permission if prompted.
7. Confirm listening state appears.
8. Speak naturally.
9. Confirm user transcription appears in the dedicated transcript area, not as a typed input.
10. Confirm the orb gives listening feedback while the user is speaking.
11. Confirm the app transitions to processing after speech ends.
12. Confirm the user transcript animates out when capture completes.
13. Confirm no stale unavailable state persists after a successful backend readiness check.
14. Confirm the app did not create or upload a completed microphone recording.

### Flow C — discovery selection

1. Tap the orb.
2. Say: “Play The Handoff Test.”
3. Confirm the correct episode opens.
4. Return to discovery and say: “Play the latest episode of The Daily.”
5. Confirm Murmur shows a searching state, opens a real current episode from The Daily RSS feed, and begins playback.
6. Repeat with a second show that is not in the preloaded visual catalog.
7. Say: “Joe Rogan podcast.” Confirm the official show resolves and begins playback.
8. Confirm a catalog failure is labeled “Podcast unavailable,” not “Voice unavailable.”
9. Confirm the transition feels intentional and does not expose prototype controls.

For a production episode with no timed transcript, ask one general follow-up and one exact-moment follow-up. The general question should receive a spoken answer grounded in episode metadata and conversation history. The exact-moment question must briefly disclose that timed context is missing and must not invent or quote dialogue.

### Flow D — RSS-backed playback surface

Source:

- `DEV_PLAN.md` podcast playback state.
- `DESIGN_PLAN.md` playback surface.

Checks:

1. Start an RSS-backed episode or the controlled Handoff demo.
2. Confirm audio loads.
3. Confirm playback position is tracked.
4. Confirm the background uses the current episode/podcast cover at low opacity.
5. Confirm the playback surface shows active audio motion.
6. Confirm conventional playback chrome is not the primary UI.
7. Confirm the voice ingress is the dominant interrupt action.

### Flow E — “Hey Murmur” interruption

1. Start an episode and confirm it is audibly playing.
2. Wait for `SAY “HEY MURMUR” TO INTERRUPT`.
3. Speak ordinary words that do not include the complete phrase; confirm playback continues.
4. Say: “Hey Murmur, what did that mean?”
5. Confirm playback pauses immediately and the protected timestamp matches the interruption moment.
6. Confirm the full-screen episode voice surface opens.
7. Confirm the visible user transcript contains `what did that mean?`, not the wake phrase or earlier background speech.
8. Confirm the request is answered and returning resumes from the protected timestamp.
9. Repeat with only “Hey Murmur”; confirm Murmur stays listening for the next utterance.
10. Confirm tap-to-ask still works if wake monitoring is unavailable.

### Flow F — skip ad

1. Open/play `The Handoff Test`.
2. Move playback into the sponsored segment.
3. Say: “Hey Murmur, skip ad.”
4. Repeat through tap-to-ask with: “Skip ad.”
5. Confirm playback jumps from the sponsored segment to the verified content boundary.
6. Confirm no blind 30-second skip is used.
7. Confirm a short chime/ting or equivalent completion cue occurs.
8. Confirm the podcast resumes automatically.
9. Confirm skip does not trigger outside a verified ad marker.

### Flow G — clarifying question

1. Start an episode.
2. Tap voice mid-stream.
3. Ask: “What does handoff mean here?”
4. Confirm transcript appears.
5. Confirm Murmur gives a contextual response.
6. Confirm Murmur voice is distinct from podcast audio.
7. Confirm system response text appears inside the orb and is capped to two visible lines.
8. Confirm podcast audio and Murmur speech do not overlap.
9. Confirm returning to the episode preserves the timestamp.

### Flow H — response quality

Source:

- `DEV_PLAN.md` response policy.
- `DESIGN_PLAN.md` response design.

Checks:

1. Ask an action command such as “skip ad.”
2. Confirm Murmur does not over-explain before acting.
3. Ask a concept question.
4. Confirm Murmur gives enough context to be useful.
5. Ask a quantifiable or debate-style question if supported.
6. Confirm Murmur explains assumptions and does not overstate certainty.
7. Confirm follow-up context is preserved when implemented.

## 8. Design QA

- Homepage background covers match the reference density and scale.
- Rows scroll horizontally.
- Adjacent rows move in opposite directions.
- Background opacity stays dim enough for foreground readability.
- Orb looks like smokey glass, not flat circles.
- Resting orb has internal motion.
- Listening orb brightens and feels active.
- Detail page controls align to a deliberate grid.
- No leftover prototype copy is visible.
- No typed/freeform request input is visible.

## 9. Regression checks

Run after voice/backend changes:

- Voice capability preflight still returns ready.
- Realtime token minting succeeds from both localhost and the LAN API root.
- A representative PCM stream produces a final transcript over the Realtime socket.
- A transient first token/socket failure reconnects once with a fresh client secret; permanent configuration errors do not loop.
- A transient browser `NotReadableError` retries microphone capture once; permission denial remains an immediate settings error.
- Wake monitoring clears its uncommitted audio/transcript buffer on a rolling interval and stops clearing after activation.
- Failed preflight does not get cached forever.
- `.env.local` remains untracked.
- API key is not printed in logs.
- Server routes reject requests missing `X-Murmur-Client`.

Run after UI/motion changes:

- Reduced motion still works.
- Orb text remains readable.
- Homepage does not jank on iPhone.
- Detail page remains usable on smaller iPhone screens.

## 10. Handoff note template

Use this before handing a build back to the owner:

```md
Ready for you to test:

- Implemented slice:
- Dev plan sections checked:
- Design plan sections checked:
- Automated checks:
- Backend checks:
- Manual iPhone/web checks:
- Known not-implemented items:
- Known issues:
```

If any critical implemented flow fails, do not hand it off as ready. Report the failing flow and fix it first.

## 11. Known test gaps

- No automated real-device microphone test yet.
- No automated visual diff against the supplied mockups yet.
- No deployed API environment yet.
- No production analytics/error telemetry yet.
- No accessibility pass with VoiceOver yet.
