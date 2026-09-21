# Murmur

A voice-only Lenny’s Podcast prototype for foreground iPhone use in Expo Go, with a web preview. The current refinement pass focuses on **Brian Halligan’s interview**.

## Experience

1. Tap **Hey Murmur** on Home and say “Play Lenny” or “Play Brian Halligan.”
2. Murmur opens Brian’s interview and starts playback at your saved position. A finished interview starts over; “start over” also returns to the beginning.
3. Say **“Hey Murmur”** while playing to pause and ask about the conversation, go deeper, jump to a topic, or control playback.
4. Ask follow-ups without repeating the wake phrase. After six seconds without speech, Murmur announces “Back to Lenny” and resumes the saved position. An explicitly paused episode stays paused.
5. Say **“stop listening”** to stop playback and switch off the microphone. Backgrounding the app also stops capture and saves your place.

To try the ad break without waiting: play the episode, then say **“Hey Murmur, go to 37 minutes.”** The WorkOS ad starts at 37:10. During it, say **“Hey Murmur, skip this ad.”** Playback moves to 38:10, announces “Ad skipped. Back to Lenny,” and resumes. A skip while explicitly paused moves to the same destination and stays paused. Outside that interval, Murmur announces there is no ad to skip and preserves the position. Repeating the request cannot jump into later interview content.

Home has one activation button. The episode screen has artwork, captions, microphone status, and passive progress; neither screen has playback buttons, a scrubber, or typed input.

The initial tap enables **continuous cloud transcription**, not an offline wake-word detector. Microphone audio goes to OpenAI while the foreground listening session is active, including during podcast playback. The screen discloses this before activation. Raw microphone recordings are not stored by Murmur. This uses provider credits for the duration of listening; local wake-word detection is future work.

## Run

Requirements: Node 22.13+, Docker Desktop, and working `OPENAI_API_KEY` and `TYPESAFE_API_KEY` in `.env.local`. Copy `.env.example` only if `.env.local` does not already exist. Keys remain server-side.

```bash
npm ci
npm start
```

The launcher starts PostgreSQL and the backend, prepares Brian’s episode if needed, then opens Expo Go development over LAN. First preparation downloads about 72 MB of publisher audio and verifies its digest against the reviewed copy. Audio and transcripts remain in ignored local storage. The Mac and iPhone must share a network. Scan the terminal QR code with the iPhone Camera, open Expo Go, and allow microphone/local network access. Keep the Mac running. Expo SDK 57 requires matching Expo logins on CLI and Expo Go.

`npm run web` starts the browser preview; `npm run ios` opens an installed iOS Simulator. The Codex Run actions use the same launcher. If an older backend is already running, stop it and restart to load code changes. PostgreSQL data survives application restarts.

Web microphone capture requires localhost or HTTPS and a microphone-capable browser. An embedded preview can display the interface without exposing a microphone. A plain LAN HTTP browser page does not support microphone capture; use Expo Go on the phone.

To import or update metadata explicitly:

```bash
npm run catalog:import
npm run catalog:import -- --refresh
```

The other imported episodes remain stored. Set `MURMUR_CATALOG=all` in the server environment and restart to restore the wider catalog; use `npm run catalog:import -- --all` to import all 50 if needed.

The importer is pinned to a release of [Lenny’s official free dataset](https://github.com/LennysNewsletter/lennys-newsletterpodcastdata). Public audio streams from [Lenny’s RSS feed](https://api.substack.com/feed/podcast/10845.rss). Raw transcripts stay in ignored `.murmur-data/lenny/` and the local database. They are not checked into this repository or included in the client bundle. The dataset license covers personal noncommercial use; commercial use requires the publisher’s arrangement, and raw dataset redistribution is excluded.

## Current limits

- Brian’s WorkOS break is reviewed against the actual audio bytes. The ad ends around 38:09.8 and the interview resumes around 38:10.46, so the skip target is the gap at 38:10. Changed files, unverified markers, overlaps, and out-of-range boundaries cannot trigger an ad skip.
- Only this reviewed break is eligible for automatic boundary selection. Transcript-only markers on other episodes are insufficient. If another ad is heard, Murmur can accept a spoken time skip such as “go forward thirty seconds.” General transcript timestamps remain speaker-turn level.
- Jev selects episodes, intent, and relevant passages. OpenAI generates short grounded answers and speech. Answers finish generating before speech playback starts; speech generation is not streamed.
- Physical iPhone wake detection, speaker echo, Bluetooth routing, and exact seek precision still need device testing. Foreground capture uses Expo’s audio stream; there is no custom native echo-cancellation module or background wake listener.
- Guest identity and bookmarks persist. Cross-device accounts and public deployment are outside this prototype.

## Verification

```bash
npm run check
npm run test:backend
npm run export:web
npx expo export --platform ios --output-dir .murmur-data/ios-export
```

Backend tests require PostgreSQL and create an isolated disposable test database. Standard tests use fake providers and do not consume credits. `npm run eval:lenny` is an opt-in live catalog/answer/speech evaluation against a running backend and consumes provider credits.

See [BACKEND_V2.md](BACKEND_V2.md) for current architecture. Earlier `BACKEND.md` and plan documents describe previous iterations; the old discovery UI is no longer mounted.
