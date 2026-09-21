# Lenny voice backend

## Components

| Component | Responsibility |
| --- | --- |
| `src/features/lenny/voice-controller.ts` | Voice state machine, immediate interruption, cancellation, follow-ups, silence return, player acknowledgement |
| `voice-provider.tsx` | Expo player, PCM capture, audio session, app lifecycle, speech, API adapters |
| Home and `/listen` | One activation control on Home; passive episode artwork/status/captions |
| Expo `/api/v2/*` | Same-origin HTTP bridge with bounded request bodies |
| Fastify `backend/app.ts` | Guest authentication, catalog, listening state, voice transport, private speech |
| Jev | Constrained choices for episode selection, listener intent, relevant transcript passage |
| OpenAI | Continuous microphone transcription, transcript-grounded explanations, spoken answers |
| PostgreSQL | Identity, bookmarks, private conversation history/speech cache, transcript search, usage limits |
| Importer | Brian focus episode by default; optional 50-episode transcript release matched to public publisher RSS |

Exact playback commands remain in code. Jev cannot invent timestamps or execute arbitrary actions. Topic jumps use a selected stored passage’s start time. Low-confidence selections ask a spoken clarification. Explanations include retrieved episode passages and private recent conversation history.

Catalog selection also requires a positive match between the requested show, guest, or subject and the available catalog. Having only one candidate must not substitute Brian for an unrelated show such as The Daily.

`catalog-interpreter.ts` owns Jev questions and decision thresholds and returns a typed intent. Its episode arguments are generated from current catalog metadata. `CatalogService` validates the selected ID, resolves saved listening, and constructs announcements from the selected record; it contains no show-name or guest-name matching rules. Questions without a current episode clarify instead of silently starting the only candidate. “Stop listening” shuts down microphone capture locally, including when the network is unavailable.

`npm run eval:catalog` exercises the live Jev adapter with two fictional shows, including guest/topic selection, missing shows, negation, one-candidate substitution, resume, and an affirmative follow-up. It uses provider credits without changing the database. Unit tests separately cover invalid IDs, cancellation, ambiguous guests, metadata changes, and unavailable saved episodes.

Semantic ad skips require both a confident skip action and a separately evaluated, explicit advertising target in the utterance. An ad in the retrieved context does not turn “skip the boring part” into permission to skip it. Questions, negations, and future automatic-skip preferences do not execute a skip. These cases are checked with live Jev evaluations.

## Catalog and provenance

`npm run catalog:import` prepares Brian Halligan by default. `--all` also imports the other 49 free transcripts from official revision `72b8ae5d2ad25d4ee0b78fc1bc65b088282b6dbc`. `MURMUR_CATALOG=all` restores the wider catalog. Existing rows are retained; focus mode filters catalog selection and refuses new sessions for other episodes. Raw files are ignored local data. The importer sorts overlapping speaker starts, merges simultaneous turns, rejects timestamps outside the audio duration, and stores indexed passages transactionally per episode. It corrects three mislabeled source entries and Noam Segal’s guest label.

Brian’s focus version is the actual MP3 SHA-256 `5d55b98600573b347a83c80f180ed22ff30032f05f897fa4a53206d4cf0e8303`. The local object is immutable and served with byte ranges, HEAD, and audio/mpeg. The Expo bridge bounds the header wait but does not cut a long media body off after 30 seconds. Re-imports retain the reviewed copy. If the publisher returns different bytes, preparation requires a new review instead of reusing timestamps. Other episodes use an enclosure/transcript provenance fingerprint, which is insufficient for verified skipping.

Brian’s eligible ad is `[2230, 2290)` seconds, tied to the MP3 digest and reviewed transcript digest. Boundary audio clips confirm the sponsor’s final word ends around 2289.80 and the interview’s first word starts around 2290.46. The 2290-second target preserves the opening sentence. `ad-policy.ts` rejects transcript-only markers, missing pinned audio, mismatched versions, malformed or overlapping intervals, and out-of-duration timestamps. It uses the interruption bookmark. A repeat at the ending never skips to another ad. Other episode markers remain candidates and do not authorize skips.

## Listening loop

```text
Home tap → listen → choose episode → spoken introduction → play
play → “Hey Murmur” → immediate local pause + persistent bookmark
  → playback command → execute + acknowledge → announcement → play/pause
  → question → retrieve evidence → answer → speak → listen for follow-up
       → follow-up speech → another answer
       → six seconds silence → “Back to Lenny” → saved position → play
stop listening / background / failure → pause, stop microphone, preserve place
```

The conversation timeout starts after answer speech ends. Local speech activity postpones it while final transcription is in flight. Explicit pause does not auto-resume. Stale answers, delayed podcast transcription, duplicate completions, and cancelled requests cannot restart playback. The controller stays mounted across Home/episode route changes.

Mutations include session revision and audio version. Concurrent/stale changes are rejected. An action is acknowledged after the device seeks to its actual position; ad skips allow at most 250 ms difference and at most 50 ms before the target. Native seeks request zero tolerance. Seek and acknowledgement finish before a later interruption reads its bookmark, even if the old announcement was cancelled. Failures never announce success. Progress checkpoints occur every ten seconds and on interruptions/backgrounding.

An explicit `resumeAfterAction` from the device preserves paused state for time seeks, topic jumps, and ad skips. “Play” and “resume” still request playback. Outside a reviewed ad, the short acknowledgement returns directly to the previous playback state; questions retain the six-second follow-up window. Exact commands also support “go to 37 minutes,” “go to 37:10,” and “start over.”

## Voice transport and usage

`POST /v2/live-voice-ticket` issues a random, single-use, 30-second Murmur ticket. `/v2/live-voice` consumes it over WebSocket, validates the owning identity, and creates an upstream transcription session. Provider credentials never reach the client. Only canonical mono 24 kHz PCM16 appends and bounded commits are forwarded. Provider session changes, oversized input, and accelerated audio floods are rejected.

A connection lasts at most 14 minutes; the client renews ten seconds before expiry. It commits after approximately 900 ms silence, or periodically during uninterrupted audio. Transcription deltas allow the wake phrase to pause playback before final transcription. Speech without a wake phrase during playback is discarded as a command. One connection per identity is active. Deletion, disconnection, backgrounding, and explicit stop close capture/provider work.

Continuous transcription includes podcast sound picked up by the microphone. Web capture requests echo cancellation. Native Expo streaming is switched back to play-and-record after capture starts; physical iPhone echo and audio routing are unverified. This is not an offline/local wake detector.

Defaults are 60 operations per guest and 300 per project per database day. Initial voice connection and each additional minute consume one unit; catalog interpretation, conversational turns, and answer speech also consume units. These are usage bounds, not dollar caps. Continuous listening incurs OpenAI usage between questions. New guest creation is limited to 20 per observed source IP/day; the development bridge shares its source IP.

## Persistence and retention

Web identity uses an HttpOnly SameSite cookie; native uses SecureStore. Tokens are hashed server-side and expire after 30 days. Sessions, bookmarks, version checks, and request deduplication survive backend restarts. Raw microphone audio is not saved by Murmur; commands, questions, and generated answers are stored as private conversation history.

`DELETE /v2/identity` closes live voice and answer work and deletes owned sessions, histories, tickets, and generated speech. The original prepared fixture/worker remains for integration tests but is no longer started for the Lenny UI. Migrations use a transaction/advisory lock. A scheduled retention sweep, user-facing deletion, account login, and production edge protection remain release work.

## Routes

| Route | Purpose |
| --- | --- |
| `POST/DELETE /v2/identity` | Create/reuse or delete a guest |
| `GET /v2/catalog`, `/v2/catalog/:episodeId` | Public collection metadata, no transcript dump |
| `POST /v2/catalog/resolve` | Resolve selection or route a current-episode request |
| `POST /v2/sessions`, `GET /v2/sessions/:id` | Open/restore an owned session |
| `POST /v2/sessions/:id/observations` | Save position/interrupt/cancel |
| `POST /v2/sessions/:id/turns` | Process an idempotent utterance with trusted context |
| `POST /v2/sessions/:id/acknowledgements` | Confirm actual player action |
| `POST /v2/sessions/:id/turns/:turnId/speech` | Synthesize/cache an owned answer |
| `POST /v2/live-voice-ticket`, `DELETE /v2/live-voice` | Start/stop foreground voice |
| WebSocket `/v2/live-voice` | Continuous bounded transcription |

Legacy single-utterance `/v2/voice` and `/v2/episode` fixture remain for existing tests. Native development derives the backend host from Expo; production requires configured HTTPS API and WSS voice addresses.

## Verification

`npm run check` runs type checking, lint, and client/pure unit tests. `npm run test:backend` uses an isolated PostgreSQL database for ownership, revisions, bookmarks, cancellation, durable jobs, catalog evidence, ad bounds, quotas, ticket expiry/single-use/deletion, and media ranges.

`npm run eval:lenny` exercises the live catalog, answer, bookmark, and speech. `scripts/smoke-continuous-voice.mts <wav>` sends a supplied 24 kHz mono PCM16 “Hey Murmur, play Lenny” recording twice on one real connection and checks pre-commit deltas and completed wake phrases. Both are opt-in and consume credits. Neither replaces physical iPhone microphone/echo/seek testing.
