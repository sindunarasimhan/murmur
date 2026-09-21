# Murmur backend

The Expo API routes retain their URLs and successful response shapes. Request handlers validate input; services orchestrate product behavior; provider adapters handle external APIs. Server-only configuration and defaults live in `src/server/config.ts`.

```text
Expo API route → validated handler → service → provider adapter
                       ↓                           ↓
                  shared errors          shared bounded transport

Explore: validate → optional Jev decisions → OpenAI answer → client speech request
Discover: validate → Apple directory → exact-show guard → canonical RSS → episode
Voice: validate → short-lived Realtime transcription secret → client audio stream
```

`http/api.ts` supplies content-type checks, bounded request reads, no-store responses, and safe errors. The client marker is not authentication. `http/upstream.ts` owns cancellation, deadlines, response limits, and provider status handling. Deadlines continue through body consumption. Rejected response bodies and redirect bodies are closed; paid requests are never automatically retried.

## Endpoints and limits

| Endpoint | Input ceiling | Server work budget | Success |
| --- | --- | --- | --- |
| POST `/api/explore` | 64 KiB JSON, validated question/context/history | Jev 1.5 s, OpenAI 14 s | answer, provider, model |
| POST `/api/podcast-search` | 2 KiB JSON, query 1–240 characters | 20 s total; directory 6 s/attempt, feed 8 s including redirects | directory identity and episode |
| POST `/api/realtime-token` | 2 KiB JSON, discovery/episode surface only | 10 s | ephemeral clientSecret, expiry, model, sample rate |
| POST `/api/transcribe` | One 15 MiB audio file plus bounded multipart overhead | 40 s | transcript, provider, model |
| POST `/api/speech` | 32 KiB JSON, text 1–3,500 characters | 25 s | MP3 with AI voice disclosure |
| GET `/api/voice-capabilities` | Client marker | Local config read | transcription ready/unconfigured |

Client timeouts exceed normal provider budgets. Incoming upload duration must also be capped by the hosting gateway. Capability readiness means a key is configured, not that credits or provider availability were verified.

Response limits: answer 1 MiB; Jev, transcription and Realtime JSON 64 KiB; speech audio 8 MiB; directory 512 KiB; feed 10 MiB. Realtime secrets require a future expiry. OpenAI Responses uses `store: false` and rejects incomplete generations. Its 1,200 output-token ceiling includes reasoning tokens; prompt guidance still asks for short spoken answers.

Errors contain `error.code`, a safe `error.message`, and `error.retryable`. Authentication and quota failures return 503 without retry; transient failures return retryable 503; timeouts return 504; cancellation returns 499. Provider bodies, credentials, prompts and audio are never logged by the backend.

## Jev decisions

TypeSafe receives the current question, episode metadata, supplied transcript window and recent dialogue. Two independent Choice questions classify intent and reasoning needs in one call. OpenAI retains all original evidence even if the answer model changes. The `X-Murmur-Decision` response header reports `jev` or `fallback` for diagnostics.

`exploration/decision-policy.ts` owns rubrics and thresholds. The TypeSafe adapter validates known option names, complete probability distributions, finite scores, the distribution sum, confidence bounds, and the selected top option. Unclear or insufficiently decisive choices retain the original intent. Missing keys, service failures and malformed responses take the standard answer path. Cancellation always propagates.

The optional fast model is restricted to confident, simple clarifications with no dialogue history or metadata-only context. Other inquiries keep the standard model. Initial thresholds are product choices, not calibrated accuracy guarantees. Confidence describes distribution concentration, not truth. Leave `OPENAI_FAST_RESPONSE_MODEL` blank until answer quality is evaluated on representative listener questions.

`npm run eval:jev` evaluates eight labeled synthetic examples against the live API. It is a smoke evaluation, not a benchmark. Deterministic pause/resume/seek, title-matching guards, and verified asset-matched ad skips do not call Jev or OpenAI.

## Discovery and deployment

The free directory lookup may retry one transient failure. Permanent HTTP failures, malformed responses, authentication errors and rate limits are not immediately retried. A total deadline covers all attempts and up to four candidate feeds. Explicit show requests retain the exact-title confidence guard. Every feed redirect is revalidated under a single feed deadline.

Feeds require HTTPS public hostnames on the default port. IP literals, local names, embedded credentials, and non-HTTPS redirects are rejected. Hostname checks do not prevent DNS rebinding: public hosting still requires DNS-aware outbound restrictions, application authentication, and durable edge rate limiting. Those deployment controls, user accounts, saved history, and external fact retrieval remain outside this prototype rewrite.

Long-lived credentials belong in ignored `.env.local` or the hosting secret store, never `EXPO_PUBLIC_` variables. TypeSafe keys are organization-scoped. OpenAI credits and keys are separate: a credit top-up does not reactivate a revoked key. Restart the local server after changing credentials; deployment secrets are configured separately.

## Verification

`npm run check` runs type checking, lint and regression tests. `npm run export:web` builds client and server. Tests cover successful flows, cancellation, stalled bodies, size limits, malformed/expired secrets, provider errors, Jev fallback and routing, and blocked redirects. Physical microphone and iPhone playback checks remain separate device QA.

References: [TypeSafe API](https://docs.typesafe.ai/api), [Choice](https://docs.typesafe.ai/primitives/choice), [OpenAI Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription), [OpenAI Responses](https://developers.openai.com/api/reference/cli/resources/responses/methods/create).
