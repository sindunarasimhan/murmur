# Murmur App Plan

> **Working docs:** Going forward, product/design annotations should happen in `DESIGN_PLAN.md`, engineering/build annotations in `DEV_PLAN.md`, QA coverage in `TEST_PLAN.md`, and ship criteria/evals in `ACCEPTANCE_EVALS_PLAN.md`. This file remains the broader source-history PRD.
>
> **Status:** The first vertical slice is implemented and under device validation. Decisions marked **TBD** are intentionally deferred and do not block autonomous progress on the agreed product direction. The voice path now uses an OpenAI Realtime stream authenticated by a server-minted short-lived secret.
>
> **Build gate:** Opened by the owner on 2026-09-06. The owner delegated routine product and engineering decisions; continue in reviewable slices and report outcomes without approval pauses.

### Current implementation slice

- Premium responsive discovery and listening room for web and iPhone, matched to the approved immersive Home reference.
- Real Expo audio playback from a live development RSS source plus a bundled, programmatically generated handoff test episode.
- Podcasting 2.0 transcript discovery and timed VTT/SRT/JSON parsing.
- Conservative voice-intent routing, exact verified ad-boundary resolution, timestamp anchoring, and proportional multi-turn explanations.
- Voice-first discovery using streamed microphone PCM → OpenAI Realtime transcript deltas → automatic intent submission. Web and iPhone share the same Realtime protocol and do not wait for a completed recording upload.
- A dedicated dormant glass sphere that transforms into a luminous ribbon aura on tap, then breathes, counter-rotates, and responds to speech energy around a two-line rolling transcript.
- Home discovery and episode interruptions share the same full-screen voice-entry surface and state language.
- A full-screen field of independently moving podcast-cover rows, with adjacent rows traveling in opposite directions at mild velocities beneath a dark visual veil.
- Voice-only natural-language input. Direct playback, navigation, retry, settings, and cancel controls may remain tappable, but there is no keyboard or dictation fallback UI.
- A visibly labeled sponsored segment in the controlled Handoff demo, with deterministic `12s → 20s` skip behavior and an explicit success confirmation.
- Server-side contextual AI answers and disclosed Murmur speech, with a no-key local preview and device-speech fallback.
- Accounts, persistence, live outside-evidence retrieval, production authentication/rate limiting, and content partnerships remain future slices.

The current public RSS source is an integration fixture, not an approved launch catalog. Its publisher retains the audio and transcript rights; production use requires a licensed or otherwise rights-cleared catalog.

## How to read this document

- **Confirmed** means it came directly from the owner's product description.
- **Proposed for V1** means it is a reasoned recommendation, not yet a locked decision.
- **TBD** means the owner still needs to decide or more research is required.

This document remains the working product source of truth. Verified implementation checkpoints should be recorded here after each slice, and an implemented behavior explicitly documented as current takes precedence over an older proposal.

Murmur's north star is a **voice-enabled, multimodal podcast experience**. Natural-language requests are voice-only, while direct actions and navigation may also use thoughtfully designed tappable or clickable UI. Text is feedback for transcription, status, context, and accessibility—not a request-entry surface. Premium minimalism describes the visual hierarchy and quality of the experience; it does not prohibit visible controls.

---

## 1. Product snapshot

### One-sentence idea

**Confirmed:** Murmur is a premium, voice-enabled podcast listening app for iPhone and web that lets people navigate by voice or interface, skip known ad segments, and explore what they hear through clarification, evidence-based debate, and deeper abstract conversation without leaving the listening experience.

### The problem

Podcast apps turn moments of curiosity or friction into context switches. A listener who wants to move past a segment, understand a reference, or explore an idea has to shift attention away from the episode and into controls, search, or another app.

Even small steps—finding a seek control, remembering a phrase, searching for it, interpreting the result, and locating the original timestamp again—break the listener's cognitive and emotional flow. Murmur should let that curiosity happen inside the listening experience.

### The promise

Murmur should let a listener stay inside the experience for as long as their curiosity takes them. They can clarify a concept, question a claim, examine numbers or evidence, debate an interpretation, or follow an idea into philosophical and abstract territory. The exchange can be brief or become a sustained, multi-turn exploration; the episode remains the anchor, and the listener's place is preserved until they choose to return.

### Why this should exist

- Voice is a first-class interaction layer, not an add-on to a conventional podcast player; touch, click, keyboard, and assistive interaction remain supported.
- Murmur understands the episode and the listener's current position.
- It can move across a known ad boundary rather than applying a blind 30-second jump.
- It can temporarily hand audio from the publisher to an AI assistant, open a contextual dialogue at any depth, and hand the experience back cleanly when the listener is ready.
- Discovery is delivered through a cinematic visual surface and a personalized spoken greeting.

## 2. Audience

### Primary users

Podcast listeners who value immersion and want to remain in the cognitive and emotional flow of long-form audio.

They engage deeply with what they hear, are comfortable speaking to an assistant, and find seeking through controls or switching to search disruptive—even when a screen is readily available.

### Secondary users

- Curious listeners who frequently pause to look up people, terms, claims, or background.
- Heavy podcast listeners who want faster discovery and a more personal listening queue.
- People with motor or vision-related access needs who may benefit from reduced touch interaction.
- People learning a topic or language who benefit from replay, clarification, and visible transcription.

### Accessibility needs

- Every tappable surface must work with VoiceOver and keyboard focus.
- Live transcription and captions are required for users who cannot rely on spoken feedback alone.
- Listening, processing, assistant-speaking, and podcast-playing states must not be communicated by color alone.
- Large text must not break essential feedback, even though on-screen copy is intentionally sparse.
- Motion must respect Reduce Motion and avoid disorienting perspective effects.
- Spoken feedback should be short, interruptible, and adjustable independently from podcast volume where feasible.
- Essential playback, navigation, retry, settings, and cancel actions require accessible UI equivalents. Freeform request entry remains voice-only by product decision; its accessibility impact must be evaluated before public launch.

## 3. Goals and success

### User goals

- Find and begin a relevant podcast through voice, visual discovery, or a combination of both.
- Skip the current verified ad segment with a natural request.
- Interrupt an episode and explore an idea through clarification, factual analysis, debate, or philosophical inquiry without losing the episode context or playback position.
- Decide when to go deeper, ask a follow-up, challenge Murmur's reasoning, or return to the episode.
- Know when Murmur is listening, what it understood, and what it is doing.
- Trust whether audio is coming from the podcast or from Murmur.

### Product goals

- Prove that voice control can feel faster and more natural than conventional podcast controls.
- Prove the two core handoffs: content → skip → content, and content → contextual exploration → content.
- Prove that a dialogue can move naturally from a concrete question into deeper analysis while remaining connected to the episode.
- Respond proportionally: perform actions with minimal narration, answer direct questions efficiently, and give concepts enough context and detail to be genuinely understood.
- Establish a premium visual and sonic identity suitable for a rich media product.
- Learn enough from listening behavior to make each return feel relevant without becoming intrusive.
- Use one product foundation for iPhone and responsive web while respecting platform differences.

### Candidate success measures

Final targets require prototype baselines. Initial measures should include:

| Outcome | Candidate measure |
|---|---|
| Voice comprehension | Requests correctly transcribed and routed without correction |
| Ad-skip precision | Verified skips that land at the intended content boundary |
| False-skip prevention | Requests that do not skip editorial content when no marker is known |
| Exploration handoff | Inquiry sessions begin, deepen, and return to podcast playback successfully |
| Conversational depth | Follow-ups preserve context across clarification, factual debate, and abstract exploration |
| Response fit | Listeners judge responses as appropriately detailed rather than too terse or too verbose for the intent |
| Transcript readiness | RSS episodes with a usable, correctly aligned feed-linked transcript |
| Resume accuracy | Difference between intended and actual return position |
| Responsiveness | Time from mic tap to listening, command to action, and question to first assistant audio |
| Trust | Test listeners can always identify assistant audio versus podcast audio |
| Discovery | Spoken or visual recommendations that lead to playback |
| Recovery | Cancellations, retries, corrections, and abandoned interactions |

### Non-goals

- **Do not replace listening with summaries.** Murmur may help explain or revisit an idea, but the full episode remains the center of the experience.
- **Do not interrupt or editorialize without the listener initiating it.** Murmur should not inject commentary, fact-checks, recommendations, or questions over the podcast on its own.
- **Do not blur publisher audio and AI speech.** A listener should always know when the episode stops and Murmur begins.
- **Do not take control away from the listener.** Murmur should not skip, reorder, shorten, or alter editorial content unless the listener asks and the action is clearly understood.
- **Do not become a detached general-purpose chatbot.** Conversations may become philosophical or abstract, but they should begin from and remain meaningfully connected to the listening experience.
- **Do not confuse voice-only requests with zero UI.** Direct playback, navigation, settings, retry, cancel, and assistive controls may remain visible and tappable.
- **Do not optimize for compulsive engagement at the expense of flow.** Feeds, streaks, badges, notifications, and recommendation loops should never overpower deliberate listening.
- **Do not treat catalog size as the primary product advantage.** The differentiator is a deeper, more fluid relationship with what the listener hears.

## 4. Core experience

### First-time user journey

1. Murmur opens directly into one immersive, dark voice surface. A central listening aura is the primary interaction, with a dim full-screen field of independently drifting podcast-cover rows behind it.
2. The user learns the core gesture: tap the aura, then speak naturally.
3. Murmur requests microphone permission only when the user initiates voice interaction. **Proposed for V1.**
4. The user asks Murmur to play something. If voice is unavailable, Murmur offers concise retry, settings, and cancel paths without opening a writing surface.
5. Playback begins and the interface recedes into a minimal “now listening” state.
6. The user taps the microphone, sees their words transcribed, and tries either “skip ad” or a question.
7. For a question, Murmur answers at an appropriate depth and keeps the episode bookmarked while the user clarifies, challenges, or goes deeper.
8. The user chooses when to return, and Murmur resumes the episode from the agreed position.

### Returning user journey

1. Murmur uses recent listening state and preferences to prepare a personalized greeting.
2. The greeting may offer to resume an episode, mention a relevant new release, or suggest something adjacent to the user's interests.
3. The user accepts through the central voice interaction.
4. Murmur restores the episode and listening position.
5. The user controls the session through voice, tappable/clickable UI, or a fluid combination of both.

Automatic greeting playback is **TBD** because browsers and iOS may require a user gesture before audio begins.

### The two “magic moments”

#### 1. Exact ad handoff

The listener requests “skip ad” while an ad is playing. Murmur recognizes the intent, identifies the verified ad range for the exact delivered audio asset, jumps to the first moment after that range, and continues without overlap or a manual seek.

#### 2. Ask, explore, return

The listener taps the microphone during an interesting or confusing moment. Murmur automatically pauses and understands the question in the context of the episode and timestamp. The listener can clarify a term, test a measurable claim, examine evidence and counterarguments, or move toward philosophical and abstract implications. Murmur remains unmistakably separate from the podcast, preserves context across turns, and returns only when the listener is ready.

The inquiry should support a natural depth progression rather than forcing separate modes:

1. **Clarify:** “What does that concept mean?” or “Who are they referring to?”
2. **Examine:** “Do those numbers add up?” or “What evidence supports that claim?”
3. **Debate:** “Make the strongest case against that argument,” compare assumptions, or quantify competing positions.
4. **Go deep:** Explore meaning, implications, values, philosophy, or a more abstract question inspired by the episode.

A single conversation may move through any or all of these levels. Murmur should not rush the listener back to playback after one answer.

### Voice interaction state model

| State | Podcast audio | Minimal visual feedback | Spoken or sonic feedback | Exit |
|---|---|---|---|---|
| Resting / loaded | Stopped, paused, or playing by context | Static aura with “I’m listening…” and a tap-to-speak invitation | None | Mic tap or episode selection |
| Listening, awaiting speech | Paused | Capture is armed; aura remains calm until speech is detected | Short listening cue | Speech, silence timeout, submit, or cancel |
| Listening, speech detected | Paused | Aura and energy bars animate; partial or final transcript replaces the resting title | None | Silence timeout, submit, or cancel |
| Understanding | Paused | Final transcript and processing state | Brief acknowledgement if latency warrants it | Intent resolved or error |
| Acting: skip | Seeking | Subtle transition | Earcon or a few words only if confirmation is useful | Podcast resumes |
| Assistant speaking | Paused and bookmarked | Visually distinct Murmur state with answer transcript | Consistent Murmur voice with entry cue | Answer ends or user interrupts |
| Exploration open | Paused and bookmarked | Episode context, conversation context, mic and return actions | Quiet ready cue if needed | Follow-up question or return request |
| Resuming | Seeking/starting | Transition back to episode artwork | Short exit cue only if needed | Podcast playing |
| Error / recovery | Paused unless safe to resume | Plain-language recovery message | Concise explanation and choices | Retry, cancel, or resume |

Murmur should not narrate routine actions. An action can be acknowledged by motion, an earcon, or a few words and then performed. Spoken detail belongs primarily to explanations, while text provides transcription, context, confirmation, and accessibility support.

## 5. Scope and priorities

### Version 1 — must have (working scope)

- [ ] A small, curated podcast catalog using audio the team is allowed to stream and process.
- [x] Podcast and episode ingestion from RSS feeds.
- [x] Voice search across the Apple Podcasts directory with canonical RSS episode resolution.
- [x] Transcript discovery through the episode-level Podcasting 2.0 `podcast:transcript` entries in the RSS feed.
- [ ] At least one test RSS feed whose episode links to a timestamp-aligned transcript and whose audio has verified ad markers tied to the exact asset.
- [x] Premium dark home experience built as one immersive inline voice surface, with a central listening aura and a full-screen field of mildly counter-scrolling decorative cover rows.
- [x] Voice-driven episode selection from the discovery surface, including shows outside the preloaded visual catalog.
- [ ] Optional accessible visual episode-selection route outside the decorative Home artwork field.
- [x] Reliable playback, seeking, buffering, position tracking, and in-session recovery.
- [x] A prominent but visually restrained tap-to-talk microphone affordance.
- [x] Thoughtfully designed tappable/clickable controls for essential playback, discovery, and recovery actions.
- [x] Voice and UI actions that always reflect the same playback and interaction state.
- [x] Automatic pause and exact timestamp capture when voice interaction begins.
- [x] Streaming speech transcription shown as feedback through `gpt-live-transcribe`; local silence detection or a second tap commits the live turn.
- [x] Voice-capability preflight that fails before a disposable recording when transcription is unavailable, with voice-only retry, settings, and cancel recovery.
- [x] No keyboard, typed-request, or dictation-fallback surface for natural-language input.
- [x] Intent routing that distinguishes actions from questions and classifies the kind of explanation being requested.
- [x] A context assembly layer using the current timestamp, nearby transcript, speaker/topic, episode metadata, and prior dialogue.
- [x] A response policy that keeps action feedback minimal while giving concept explanations greater contextual depth.
- [x] Verified ad-segment skipping without guessing when no marker exists.
- [x] A multi-turn exploration session that preserves episode and conversation context.
- [x] Support for concept clarification, fact-based or quantifiable analysis, debate/counterargument, and philosophical or abstract inquiry.
- [x] Clear separation between publisher transcript context and Murmur's generated explanation.
- [x] A distinct, disclosed Murmur TTS voice with no overlap with podcast audio.
- [x] Exact resume behavior at the saved interruption timestamp.
- [x] Clear loading, listening, processing, assistant-speaking, resuming, and error states.
- [x] Foreground “Hey Murmur” wake phrase during active playback, preserving the exact interruption timestamp and opening the existing live question surface.
- [ ] Backend storage for episodes, transcript segments, ad ranges, playback sessions, and basic preference signals.
- [ ] Basic returning-user greeting and recommendation logic if it does not delay the two core validation flows.
- [x] Working iPhone and responsive web experiences.
- [ ] Privacy controls for microphone access, listening history, transcript handling, and deletion.

### Version 1 — nice to have

- [ ] Editorial curation across multiple genres on top of the searchable production directory.
- [ ] Personalized spoken greetings that vary by session and explain why something is relevant.
- [ ] Save, share, or revisit a useful insight from an exploration.
- [ ] User correction of a live transcript.
- [ ] Simple feedback after an answer or incorrect skip.
- [ ] Subtle haptics on iPhone for listening and handoff states.

### Later versions

- [ ] On-device wake-word detection and background/lock-screen activation after separate privacy, battery, and platform validation.
- [ ] Broader RSS-feed compatibility, catalog scale, and publisher integrations.
- [ ] Automated ad classification where publisher markers are unavailable.
- [ ] Cross-device history and handoff.
- [ ] Downloaded/offline playback and, if feasible, offline voice actions.
- [ ] Background and lock-screen voice interaction.
- [ ] Deeper recommendation models and configurable assistant persona.
- [ ] Additional languages for transcription, reasoning, and speech.

### Explicitly out of scope for V1

- Background or lock-screen microphone monitoring. The foreground playback wake phrase is intentionally in scope.
- An open-ended claim of supporting every public podcast.
- A full library-management system comparable to established podcast platforms.
- Creator publishing tools.
- Social/community features.
- Fully autonomous playback choices without explicit user consent.

## 6. Screens and navigation

### Screen map

| Screen or state | Purpose | How users reach it | Primary action | Version |
|---|---|---|---|---|
| Welcome and permissions | Explain voice capabilities and request access at the right moment | First launch | Continue / activate mic | V1 |
| Home / discovery | Open directly into immersive voice discovery with a contextual greeting | App launch, episode end, back | Tap the central aura and speak | V1 |
| Now listening | Keep the episode immersive while exposing Murmur availability | Episode selection or resume | Tap mic and speak | V1 |
| Voice interaction layer | Show listening, transcription, understanding, and recovery | Mic tap | Ask or command | V1 |
| Exploration | Hold a multi-turn inquiry while separating Murmur from publisher audio | Contextual question | Ask, challenge, go deeper, or return | V1 |
| Privacy and preferences | Control history, personalization, voice data, and permissions | Secondary path | Review or change settings | V1, scope TBD |
| Listening history / library | Resume and manage followed content | Secondary path or voice | Resume/select episode | Later or V1-lite |

### Navigation model

**Proposed for V1:** An immersive stack with a deliberate set of visible controls. Whether persistent tabs or another navigation model are useful remains **TBD**.

Welcome → Home / inline voice discovery → Now listening ↔ Voice interaction → Exploration ↔ Now listening

Settings and recovery controls can appear as a secondary sheet or accessible route. On web, browser history and direct episode URLs should still behave predictably even when conventional navigation chrome is hidden.

### Screen specifications

#### Welcome and permissions

- **Purpose:** Build trust and teach the single essential gesture.
- **Information shown:** A concise statement of value, microphone state, privacy link, direct navigation choices, and an animated example of tap-to-talk.
- **Primary action:** Begin or try the microphone.
- **Important states:** Permission not requested, granted, denied, restricted, and browser unsupported.
- **Accessibility:** Full keyboard and screen-reader path; no permission request before its purpose is explained.

#### Home / discovery

- **Purpose:** Start or resume listening through one immersive voice-led surface.
- **Information shown:** A central listening aura, contextual voice feedback, and a dim full-screen matrix of podcast covers as atmosphere rather than selection controls.
- **Primary action:** Tap the central aura and speak naturally.
- **Other actions:** Keep voice retry, settings, and cancel actions accessible without opening a keyboard or turning the decorative artwork field into a control.
- **Resting state:** Show one coherent, dormant glass sphere with “Hey there.” and “What would you like to listen to?” before capture begins. Its internal movement should be nearly imperceptible and must not resemble the active ribbon halo or imply that the microphone is recording.
- **Listening state:** On tap, immediately transform into the luminous coral/magenta ribbon aura, softly breathe and counter-rotate its layers, and show “I’m listening.” with “Go ahead.” even before words arrive.
- **Transcription state:** When speech is detected, strengthen the reactive bloom and growth, animate the energy meter, show a small “Listening…” label, display only the latest two transcript lines, and expose an in-aura stop control. Preserve the full transcript for intent routing.
- **Cover motion:** Fill the viewport with a clean, consistently sized, staggered artwork matrix rather than colliding or independently tilted cards. Adjacent rows move in opposite directions at independent, mild speeds under a strong dark veil. Disable ambient motion for Reduce Motion.
- **Empty state:** A curated starter set that does not require personalization.
- **Loading/error:** Preserve the visual atmosphere and offer a spoken or accessible retry.

#### Now listening

- **Purpose:** Preserve immersion and make an interruption feel like part of the same listening flow.
- **Information shown:** Dominant episode artwork, minimal episode identity, ambient progress, mic availability, and transient transcript/status.
- **Primary actions:** Tap the microphone or use visible playback controls.
- **Other actions:** Interact with artwork, episode information, queue/discovery elements, and recovery controls as defined for V1.
- **Important states:** Loading, buffering, playing, paused for voice, seeking, ended, and playback error.

#### Voice interaction layer

- **Purpose:** Make it obvious that Murmur is listening and accurately reflect what it heard.
- **Information shown:** Active mic state, waveform or energy response, a maximum two-line live transcript, and compact voice-only recovery affordances.
- **Primary action:** Speak naturally.
- **Exit:** Speech completion, silence timeout, explicit cancel, or accessibility control.
- **Important states:** No speech, partial transcript, low confidence, denied permission, offline, processing, and intent not understood.

#### Exploration and return

- **Purpose:** Let the listener pursue an idea at the depth they choose without being mistaken for podcast content or losing the episode.
- **Information shown:** A separate color, motion, and acoustic mode; the current question and answer transcript; relevant episode context; and clear follow-up and return actions.
- **Audio treatment:** Consistent Murmur voice, short entry/exit earcon, and no overlap with publisher audio.
- **Continuation:** After an answer, the episode remains bookmarked while the listener can ask a follow-up, request evidence, challenge a conclusion, ask Murmur to quantify something, or go deeper.
- **Exit:** The listener explicitly returns by voice or UI. An optional inactivity policy is **TBD**, but Murmur should not automatically end a substantive exploration after one answer.
- **Recovery:** The listener can interrupt or cancel the answer and immediately return to the saved podcast position.

## 7. Features and behavior

### Feature: Voice command entry

- **User story:** As a listener, I want one consistent way to speak to Murmur while retaining direct UI controls whenever they are faster or more comfortable.
- **Expected behavior:** Tapping the mic immediately captures the current playback position, pauses the podcast, starts listening, and displays live transcription.
- **Proposed V1 rule:** All spoken requests, including “skip ad,” use tap-to-talk. The same actions may also have visible UI entry points; whether any spoken command should be hands-free in V1 is an open question.
- **Failure behavior:** Never discard the saved playback position. Offer retry, cancel, or return to playback.
- **Required permission:** Microphone.
- **Version:** V1.

### Feature: Context-aware response policy

- **User story:** As a listener, I want Murmur to recognize whether I asked it to do something or explain something, so the interruption feels useful without becoming unnecessarily long.
- **Context before response:** Murmur should interpret the request using the saved playback timestamp, nearby transcript, current speaker and topic, episode metadata, relevant earlier parts of the episode, prior exploration turns, and the listener's depth preference when known.
- **Context presentation:** Use that context internally, but do not recite it back. Surface only the pieces needed to make the action or explanation understandable.

| Intent class | Examples | Behavior | Default spoken depth |
|---|---|---|---|
| Action | Skip this ad; replay that; save this; resume | Perform the action, then return to listening | No narration, an earcon, or one brief confirmation |
| Navigation or status | What am I listening to? Play the next one | Answer or act directly | One direct sentence or a small set of choices |
| Factual question | Who is that? When did this happen? What number did they cite? | Give the answer and only the context needed to connect it to the episode | Short and direct; expand if challenged |
| Concept explanation | What does this idea mean? How does it work here? | Explain the concept, connect it to what was just said, and use an example, distinction, or implication where useful | More detailed than an action or fact; enough to create understanding without becoming a lecture |
| Quantitative examination or debate | Do those numbers add up? What assumption changes the conclusion? | State the result, key evidence or calculation, assumptions, and strongest counterpoint | Structured and focused; deepen turn by turn |
| Philosophical or abstract exploration | What does this imply about identity? Is that ethically defensible? | Frame the central tension and explore a small number of meaningful perspectives | Focused opening synthesis; expand as the listener goes deeper |
| Ambiguous or consequential action | Skip that; delete this; change my history | Ask one focused clarifying question before acting | As short as possible |

- **Progressive depth rule:** Start with the smallest response that fully answers this kind of request, then preserve context so “explain that,” “go deeper,” “show me the numbers,” or “argue the other side” expands the same thread.
- **Control rule:** The listener can interrupt, say “shorter,” ask for more detail, or return to the episode at any point.
- **Version:** V1.

### Feature: Verified ad skip

- **User story:** As a listener, I want to say “skip ad” and arrive precisely at the next editorial content rather than guessing with repeated 30-second jumps.
- **Expected flow:**
  1. Preserve the current playhead and pause or duck audio.
  2. Transcribe and classify the request as a skip-ad intent.
  3. Match the playhead to an ad segment for the exact episode asset/version.
  4. Seek to the verified segment's end timestamp.
  5. Confirm briefly and resume playback.
- **Core data:** Asset version, start time, end time, marker source, and confidence for every ad segment.
- **Important rule:** If the playhead is not inside a verified segment, Murmur must not invent a boundary.
- **Edge cases:** Dynamic ad insertion changes the asset; multiple adjacent ads; the command arrives near a boundary; stream seeking fails; playback is already past the marker; no marker exists.
- **Fallback when no verified marker exists:** **TBD.** Options include saying it cannot verify the ad, offering a conventional short jump, or asking the listener what to do.
- **Version:** V1 with controlled/curated media; broader detection later.

### Feature: Contextual exploration and audio handoff

- **User story:** As a listener, I want to question, clarify, debate, and deeply explore what I just heard without leaving the listening experience or losing my place.
- **Expected flow:**
  1. Mic tap captures the exact position and pauses the episode.
  2. Murmur listens and exposes the live transcript.
  3. The backend retrieves timestamp-aligned transcript context, prior dialogue turns, episode metadata, and any permitted supporting knowledge.
  4. Murmur identifies whether the listener is seeking clarification, factual or quantitative examination, debate/counterargument, or abstract exploration—without forcing them to pick a mode.
  5. The LLM produces a spoken-first response whose depth matches the question and whose source boundaries are clear.
  6. A distinct Murmur voice and entry cue deliver the response.
  7. The episode remains paused and bookmarked while the listener asks follow-ups, challenges the answer, changes the level of abstraction, or chooses to return.
  8. When the listener ends the exploration, Murmur returns to the saved position or an agreed small rewind.
- **Knowledge rule:** The episode is the conversational anchor, not the ceiling. Murmur may use permitted outside knowledge to check facts, quantify claims, compare evidence, or explore implications, but it must distinguish the episode's words from external facts and its own interpretation.
- **Quantitative rule:** For measurable claims, expose assumptions, calculations, uncertainty, and evidence rather than presenting an unsupported verdict.
- **Abstract rule:** For philosophical questions, offer meaningful perspectives and counterpositions without pretending there is one objectively settled answer.
- **Conversation memory:** Preserve the episode timestamp and prior turns throughout the exploration so “go deeper,” “argue the other side,” or “what do you mean by that?” works naturally.
- **Edge cases:** The transcript is missing or misaligned; the question refers to an earlier section; the speaker's claim is ambiguous; evidence conflicts; the question drifts away from the episode; network/STT/LLM/TTS fails; the user interrupts the answer; the episode asset changes.
- **Grounding rule:** Murmur should express uncertainty instead of fabricating an explanation or source.
- **Version:** V1.

### Feature: Personalized spoken greeting and discovery

- **User story:** As a returning listener, I want Murmur to remember my listening context and suggest something worthwhile without making me browse.
- **Expected behavior:** Vary the greeting among resuming an unfinished episode, highlighting a relevant new release, or offering something adjacent to the user's interests.
- **Presentation:** Deliver the greeting inside the Home voice surface, with the central aura as the interaction point.
- **Inputs:** Listening history, completions, skips, explicit likes/dislikes, topics, time since last session, and freshness of available episodes.
- **Rules:** Keep it short, explain relevance naturally, avoid repeating the same phrasing, and allow personalization/history to be disabled or cleared.
- **Platform constraint:** Automatic voice playback may require a prior user gesture.
- **Version:** Basic rules in V1 if feasible; learned ranking later.

### Feature: Clear source identity

- **User story:** As a listener, I always want to know whether I am hearing the publisher's podcast or Murmur's generated response.
- **Expected behavior:** Murmur uses one consistent assistant voice, a restrained sonic cue, controlled silence/ducking, and a distinct visual state before speaking.
- **Rules:** Never clone or imitate a podcast host's voice. Never overlap an answer with the episode. Allow interruption.
- **Version:** V1.

## 8. Content and language

### Voice and tone

**Proposed:** Calm, intelligent, warm, intellectually curious, and confident without pretending certainty. Murmur should sound like a thoughtful listening companion, not a radio host and not a character competing with the episode.

Spoken responses should be **compact by default, but not uniformly terse**. Murmur should spend almost no words narrating an action. A direct fact can be brief. A concept explanation deserves more room: a plain-language explanation, how it relates to the exact passage, and an example, distinction, or implication when useful. Quantitative debate and philosophical exploration should begin with a focused structure and deepen across turns rather than opening with a monologue.

The listener can steer naturally with “shorter,” “explain that,” “go deeper,” “quantify that,” “challenge that,” “explain the assumption,” or “argue the other side.” Murmur should remember both the listening context and the requested depth.

Operational system messages should still be shorter than their visual equivalents. Examples:

- Listening: use a short sound rather than “I am listening now.”
- Successful skip: “Skipping the ad,” or no speech if the transition is self-evident.
- Processing delay: “One moment—I’m checking that part.”
- Uncertainty: “That wasn’t clear from this episode.”
- Return: use a brief sonic cue rather than a repeated announcement.

Final copy and sonic branding are **TBD**.

### Key terminology

| Internal concept | User-facing expression | Meaning |
|---|---|---|
| Assistant | Murmur | The AI listening companion |
| Voice activation | Tap to talk | Explicitly begin a voice request |
| Editorial audio | Podcast / episode | Publisher-supplied program audio |
| Generated audio | Murmur's answer | AI-generated spoken response |
| Ad segment | Ad | Verified non-editorial range in the delivered audio |
| Playback position | Your place | Point preserved across an interruption |

### Content supplied by

- Apple Podcasts Search API: show discovery and canonical RSS feed location.
- Podcast publishers through RSS: episode audio enclosures, artwork, metadata, and `podcast:transcript` links when supplied; ad markers may require a separate source.
- The product team: curated collections, onboarding copy, sonic identity, and test content.
- Users: voice requests, preferences, playback behavior, and optional feedback.
- AI systems: transcription, contextual answers, greeting variants, and synthesized Murmur speech.

## 9. Visual direction

### Desired feeling

- Premium
- Cinematic
- Immersive
- Calm
- Spatial
- Intelligent

### Design references

- **Netflix:** Confidence, depth, artwork-led browsing, dark cinematic space, and content that feels larger than the controls. This is inspiration, not a visual replica.
- **Apple Podcasts / Spotify:** Reference points for playback reliability and episode metadata, not for Murmur's interface structure.

Additional visual and sonic references are **TBD**.

### Color

- **Core palette:** Near-black layered surfaces, rich shadow, controlled highlights, and artwork-driven color extraction. Exact tokens TBD.
- **Primary mode:** Dark.
- **Light mode:** TBD; not required for the initial artistic direction, subject to accessibility review.
- **State colors:** Listening, processing, assistant speech, and errors must be distinguishable but restrained.
- **Avoid:** Generic neon “AI” gradients, busy dashboards, large blocks of explanatory copy, and low-contrast gray-on-black text.

### Typography

- Editorial and cinematic rather than technical.
- Sparse metadata with strong hierarchy.
- Transcription must prioritize legibility, line stability, and large-text support over decoration.
- Typeface and licensing are **TBD**.

### Imagery and iconography

- The central listening aura is Home's primary visual and interactive anchor.
- Podcast covers form a dim, full-screen decorative background field behind the Home aura; artwork remains prominent in episode and player views.
- Voice activation should feel embedded in the aura, not like a floating generic utility button.
- Icons should be rare, familiar, and accessible.

### Motion and interaction

- Quiet, state-responsive movement in the central listening aura.
- Gentle continuous drift across multiple Home artwork rows, with adjacent rows moving in opposite directions.
- Responsive but quiet waveform/energy feedback while listening.
- A deliberate visual transformation when Murmur speaks so the source change is unmistakable.
- Seamless handoff back to episode art when the podcast resumes.
- No motion that delays playback or hides a state change; Reduce Motion alternatives are required.

### Design principles

1. **Audio leads; visuals reassure.**
2. **Give every surface a clear primary intent, with supporting controls arranged around it.**
3. **Never make the listener wonder who is speaking.**
4. **Preserve immersion and the listener's place.**
5. **Use motion primarily to communicate state; keep ambient motion calm and subordinate.**
6. **Minimal does not mean inaccessible or unrecoverable.**

## 10. Platform behavior

### Shared across iPhone and web

- Same episode identity, transcript alignment, command meanings, assistant voice, and handoff model.
- Responsive dark visual system, central voice aura, and full-screen counter-scrolling cover-field behavior.
- Persistent playback position and interaction history when identity/sync is enabled.
- Equivalent listening, processing, answer, error, and recovery states.

### iPhone-specific

- iPhone is the proposed primary quality target.
- Configure audio sessions so playback, microphone recording, interruptions, route changes, and TTS do not conflict.
- Handle calls, Siri, headphones, Bluetooth, silent mode, and app backgrounding predictably.
- Use subtle haptics for mic activation and handoffs if accessibility settings allow.
- Background playback is expected of a podcast app, but whether it is required for the first prototype is **TBD**.
- Lock-screen controls, CarPlay, and background voice activation are **TBD/later**.
- Native microphone/audio work may require an Expo development build rather than Expo Go.

### Web-specific

- Browsers may require a click/tap before starting audio or requesting microphone access.
- Support keyboard activation and visible focus for every essential action.
- Handle permission denial, unsupported recording APIs, suspended audio contexts, and tab backgrounding.
- Use direct episode URLs and predictable browser navigation where practical.
- Media Session integration is proposed for basic OS/browser playback controls.

### Devices and orientation

- **Minimum iPhone/OS:** TBD after dependency and audience review.
- **Web:** Responsive phone, tablet, laptop, and desktop layouts.
- **Orientation:** Portrait-first on iPhone; responsive landscape/web presentation. Exact iPad scope TBD.

## 11. Accounts, identity, and permissions

- **Account requirement:** TBD. A device-local guest mode is proposed for the first prototype.
- **Sign-in methods:** TBD.
- **Profile information:** Minimal identity plus optional listening preferences; exact fields TBD.
- **Guest mode:** Proposed, with local history and a clear path to delete it.
- **Account deletion:** Must delete or anonymize profile, history, recommendation signals, stored transcripts of user speech, and other linked personal data according to the final retention policy.
- **Device permissions:** Microphone is required for voice features. Notifications and tracking must be optional and requested contextually.
- **Personalization controls:** View or disable learning, clear listening history, and delete voice interaction history.

## 12. Data, integrations, and system shape

### Main data objects

| Object | Important fields | Created by | Proposed storage |
|---|---|---|---|
| User / profile | ID, preferences, preferred response depth, consent, locale | User/system | Backend; guest subset on device |
| Podcast | Feed URL, feed/source ID, title, artwork, publisher, rights state, refresh metadata | RSS ingestion | Backend/catalog |
| Episode | RSS item GUID, podcast ID, enclosure URL, audio asset/version, duration, metadata | RSS ingestion | Backend/catalog |
| Transcript source | Episode ID, source URL, MIME type, language, captions relation, timed/untimed, provenance | RSS `podcast:transcript` entry | Backend/catalog |
| Transcript segment | Episode/asset ID, start/end time, speaker, text, source reference, confidence | Normalized feed-linked transcript | Searchable backend index |
| Ad segment | Episode/asset ID, start/end time, source, confidence | Publisher/team/detection pipeline | Backend |
| Playback session | Episode, position, state, device, timestamps | Client | Local plus backend if signed in |
| Voice interaction | Playback position, transcript, intent, outcome, latency | Client/backend | Short-lived or retained by consent |
| Exploration session | Episode/time anchor, dialogue turns, inquiry types, response depth, sources, open/closed state | Client/backend | Session store; retention by consent |
| Recommendation signal | Play, completion, skip, topic, recency, feedback | Client/backend | Preference/history store |

### RSS and transcript ingestion

**Confirmed source:** Murmur obtains podcast metadata, episode metadata, audio enclosure URLs, and publisher-supplied transcript links from RSS feeds.

The [Podcasting 2.0 transcript specification](https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md#transcript) defines an episode-level `podcast:transcript` element. The RSS element links to the transcript file rather than necessarily embedding the transcript inside the feed.

1. Discover a podcast's canonical RSS feed URL through the Apple Podcasts directory or a known feed registration.
2. Parse channel metadata and each episode item, including its stable GUID and audio enclosure.
3. Read every `podcast:transcript` entry on the episode item. Multiple entries may represent different languages or formats.
4. Select a transcript matching the listener/episode language and prefer a time-aligned format suitable for mapping text to playback position.
5. Fetch the linked transcript on the backend, validate it, preserve its source/provenance, and normalize it into timestamped segments for search and contextual exploration.
6. Associate the normalized transcript with the exact episode and audio asset so a question at a playback timestamp retrieves the correct passage.
7. Refresh feeds conditionally and detect changed episode enclosures or transcript URLs without duplicating episodes.

The standard can identify formats including plain text, HTML, WebVTT, JSON, and SubRip. **Proposed preference:** use a supported time-aligned JSON, WebVTT, or SubRip transcript when available; untimed text may support general episode questions but cannot reliably provide precise timestamp context without an additional alignment step.

If an episode has no `podcast:transcript` entry, the transcript URL fails, or only an unusable format is available, Murmur should mark contextual exploration unavailable for that episode rather than fabricate context. Whether Murmur may generate and align a private fallback transcript is **TBD**.

RSS and transcript fetching must be performed defensively: HTTPS where required by the namespace, redirects and response sizes limited, MIME/content validated, timeouts enforced, and untrusted XML parsed without external entity expansion.

### Proposed client-to-backend flow

1. The backend ingests the RSS item and its feed-linked transcript; the client streams the selected episode from its enclosure and maintains a stable playback position.
2. Mic activation pauses playback and sends speech to transcription, directly or through the backend.
3. An intent layer distinguishes an action from an explanation, then routes it to deterministic playback behavior or opens a contextual exploration session with the appropriate response depth.
4. Skip actions resolve against markers for the exact audio asset and return a seek target.
5. An exploration session preserves the episode timestamp, transcript window, metadata, previous dialogue turns, and source references.
6. Each inquiry can retrieve permitted external evidence, perform calculations, or compare perspectives when the question requires it.
7. The LLM produces a response with appropriate depth and explicit source/interpretation boundaries, which TTS converts to the established Murmur voice.
8. The client plays the answer and keeps the episode bookmarked while the user continues the dialogue.
9. When the user ends the exploration, the client restores the saved episode state and records the outcome/latency.

All provider credentials must remain behind a server boundary; they must not ship in the web or iPhone client.

### External services to select

- Apple Podcasts Search API is the implemented discovery directory; RSS remains the canonical source for podcast/episode metadata, audio enclosures, and transcript links.
- Rights-cleared episode audio for the controlled prototype.
- Parsing and normalization for feed-linked transcript formats plus searchable retrieval.
- Transcript generation/alignment only as a possible fallback when RSS does not provide a usable timed transcript; policy is **TBD**.
- Speech-to-text with partial results.
- LLM for intent support, multi-turn reasoning, debate, and abstract exploration anchored to the episode.
- Evidence retrieval, source attribution, and calculation tools for factual or quantitative questions.
- Text-to-speech with streaming audio and a consistent licensed voice.
- Backend database, object storage, and optional vector/search index.
- Authentication, analytics, crash reporting, and observability.

Vendors remain **TBD**; architecture should keep the STT, LLM, and TTS providers replaceable.

### MVP feasibility constraint

**Proposed for V1:** Start with a controlled set of RSS feeds and an owned or explicitly licensed test episode whose RSS item supplies the exact audio enclosure and a usable timed transcript link, with ad boundaries known for that audio asset.

Exact ad skipping cannot be guaranteed from arbitrary audio alone. Dynamically inserted ads can change by listener, time, or download, so an ad marker is valid only when it matches the actual delivered asset/version. Publisher-provided markers or controlled preprocessing are the safest proof path.

### Offline and synchronization behavior

- Initial prototype may require a network connection for catalog, STT, LLM, and TTS.
- Local playback position should survive app closure and transient network loss.
- Cross-device sync and downloaded/offline AI behavior are later/TBD.

### Import and export

- Direct RSS-feed ingestion is a core input, not an optional import feature.
- User-facing custom-feed entry, OPML import, listening-history import, and data export are **TBD**.
- Users must eventually be able to request an export/deletion of personal history where required.

## 13. Privacy, safety, rights, and trust

- Voice audio, speech transcripts, listening history, inferred interests, and questions may be sensitive.
- The microphone must activate only after an explicit gesture in V1, with an unmistakable listening state.
- Minimize raw audio retention. The default proposal is to discard raw mic audio after transcription unless the user explicitly opts into diagnostic sharing.
- Define retention separately for raw voice, voice transcripts, exploration sessions, LLM prompts/answers, listening history, and analytics.
- Provide controls to disable personalization and delete learned behavior.
- Clearly identify AI-generated speech and never imitate hosts or guests.
- Ground answers, disclose uncertainty, and avoid presenting Murmur as the publisher or speaker.
- Health, legal, financial, and other consequential questions need appropriate limits and careful phrasing.
- Podcast audio, artwork, RSS metadata, feed-linked transcripts, and derived indexes require a documented rights basis. Preserve the publisher transcript's provenance and do not silently present generated or altered text as the publisher's original.
- Ad skipping may conflict with publisher terms, licensing, and monetization models. Product/legal partnership review is required before third-party rollout.
- Age rating, regional availability, privacy policy, terms, AI disclosure, and consent requirements are **TBD**.

## 14. Business model

- **Model:** TBD.
- **Possible direction:** Consumer subscription or publisher/platform partnership, but no decision has been made.
- **Key tension:** Skipping advertising can remove publisher value. The product model must define how creators and rights holders are supported before broad launch.
- **Free/paid boundaries, trial, App Store purchases, and web billing:** TBD.

## 15. Notifications and communication

- Personalized new-episode alerts may be useful later but are not core to validating V1.
- Spoken greetings should not become unsolicited or repetitive notifications.
- Push, email, quiet hours, frequency caps, and recommendation controls are **TBD**.
- All marketing communication should be opt-in and separate from essential account/service messages.

## 16. Analytics and feedback

### Important events

- App/session started; greeting offered, completed, or interrupted.
- Recommendation shown/spoken, accepted, rejected, or ignored.
- Episode selected, started, resumed, buffered, completed, or abandoned.
- Mic activated/cancelled; permission granted/denied.
- Partial/final transcript produced; correction or retry requested.
- Intent resolved as skip, clarification, factual/quantitative inquiry, debate, abstract inquiry, other command, or unknown.
- Ad skip requested, marker found/not found, seek completed/failed, and boundary correction reported.
- Exploration opened; retrieval completed; first assistant audio; answer interrupted/completed; follow-up requested; depth changed; exploration closed.
- Response class and duration; “shorter,” “explain,” or “go deeper” adjustments; action confirmations interrupted or skipped.
- Dialogue turns and source-boundary failures, measured without placing the conversation's private contents in analytics.
- Podcast resume requested/completed and measured resume drift.
- Network, playback, STT, LLM, TTS, and permission errors.

### Feedback

- Provide a low-friction way to report a wrong transcript, answer, ad boundary, or recommendation.
- Collect qualitative usability feedback during the controlled alpha, especially about trust and interruption.

### Privacy limits

- Do not put raw voice, full questions, transcript content, or sensitive episode context into general analytics events.
- Use pseudonymous identifiers, event minimization, access controls, and documented retention.
- Crash and performance monitoring provider is **TBD**.

## 17. Quality requirements

### Candidate experience targets

These are starting hypotheses, not approved service levels:

- Podcast pause after mic tap feels immediate; target under 250 ms where the platform allows.
- Listening indication appears immediately and command acknowledgement begins within roughly 500 ms after recognition.
- A verified ad seek settles and playback restarts within roughly 1 second on a healthy connection.
- First assistant speech begins within roughly 2.5 seconds for a typical question, ideally streamed.
- Longer answers stream progressively, remain interruptible, and preserve conversational context across follow-ups.
- Routine actions do not trigger verbose explanations; concept responses include enough episode-specific context to stand on their own.
- Resume drift stays under 250 ms unless the product intentionally rewinds.
- Podcast and assistant audio never overlap.
- A failed voice/AI action never loses the saved playback position.

### Broader requirements

- **Reliability:** Playback and position persistence take priority over visual effects or AI enhancements.
- **Accessibility:** Target WCAG 2.2 AA for web and equivalent iOS accessibility practices; final target TBD.
- **Localization:** English-first is proposed; required languages and locales are TBD.
- **Security:** Server-side secrets, encrypted transport/storage as appropriate, least-privilege access, abuse controls, and auditable deletion.
- **Performance:** Aura and cover-rail motion should stay smooth on supported devices and degrade gracefully with Reduce Motion or lower capability.
- **Testing:** Real-device audio-session tests, headset/Bluetooth routes, interruption recovery, browser permission matrices, poor networks, and timestamp accuracy.
- **Feed testing:** RSS fixtures covering namespace prefixes, multiple transcript formats/languages, redirects, malformed XML, duplicate GUIDs, changed enclosures, missing transcripts, untimed transcripts, and failed transcript URLs.

## 18. Validation and launch plan

### Verified checkpoint — 2026-09-07

| Slice | Result |
|---|---|
| Home composition | Verified at `390×844` with the reference hierarchy, a dedicated dormant glass sphere, and a clean full-screen cover matrix |
| Cover motion | Verified six independent rows moving in alternating directions at roughly `2.55–3.36 px/s`, with deliberate spacing and seamless looping |
| Voice states | Dormant sphere, immediate tap transformation, breathing microphone-open aura, energy-reactive two-line transcription, processing, and voice-only recovery are implemented |
| Expo Go transcription | Client PCM capture, short-lived Realtime authentication, transcript deltas, turn commit, and intent submission are implemented; physical-device validation remains required |
| Voice recovery | Connection or microphone failure exposes retry, settings, or cancel without creating a disposable recording or writing surface |
| Episode selection | “Play The Handoff” resolves the bundled controlled demo through the same intent-routing path |
| Sponsored segment | The player clearly shows the verified sponsored range and remaining time while inside it |
| Skip handoff | Verified from `0:15`: “skip ad” resolves the exact `12s–20s` marker, resumes at `0:20`, and removes the sponsor state |
| Build quality | TypeScript, lint, 112 unit tests, 21 Expo health checks, and web/iOS exports pass |

### Proposed sequence after the build gate opens

1. **Foundation:** Confirm rights-cleared test content, audio asset identity, transcript timing, ad markers, and backend provider choices.
2. **Playback spine:** Build selection, playback, position persistence, and audio-state recovery before AI behavior.
3. **Magic moment 1:** Validate tap-to-talk → “skip ad” → exact verified boundary → resumed content.
4. **Magic moment 2:** Validate pause → clarification → deeper multi-turn exploration → distinct spoken responses → listener-directed return.
5. **Premium shell:** Refine the immersive Home voice surface, listening aura, ambient artwork field, sonic identity, accessibility, and responsive layouts.
6. **Personalization:** Add behavior-backed greetings and recommendations after core handoffs are dependable.
7. **Controlled alpha:** Test with a small group and instrument accuracy, latency, trust, and recovery.
8. **Broader beta:** Expand catalog/platform support only after rights, markers, cost, and quality are understood.

### Launch details

- **Target window:** TBD.
- **Initial audience:** Proposed small, consented alpha using a curated catalog.
- **Web hosting:** TBD.
- **iPhone distribution:** Development build/TestFlight before App Store submission.
- **Required legal pages:** Privacy policy, terms, AI disclosure, content/rights notices, and account deletion information as applicable.
- **Support channel:** TBD.

## 19. Key risks and mitigations

| Risk | Why it matters | Proposed mitigation |
|---|---|---|
| Unknown or dynamic ad boundaries | A wrong jump breaks trust and can skip editorial content | Match markers to exact asset versions; never guess in V1 |
| Missing/misaligned feed transcripts | Answers may be irrelevant or fabricated | Require a usable timed `podcast:transcript` source for exploration or apply an explicitly approved fallback; check alignment and express uncertainty |
| Unsupported factual or quantitative claims | A confident but ungrounded debate destroys trust | Retrieve evidence, expose assumptions/calculations, attribute sources, and separate facts from interpretation |
| STT/LLM/TTS latency | Long silence breaks the conversational handoff | Stream partial/final results and audio; use short spoken progress feedback |
| Audio-session conflicts | Recording, TTS, and playback can overlap or fail | Central audio state machine and real-device/platform tests |
| Voice and UI fall out of sync | Conflicting states make playback unpredictable | One shared state model for spoken, touch, click, keyboard, and assistive actions |
| Assistant mistaken for host | Damages editorial trust | Unique voice, earcons, visual state, silence between sources |
| Content/ad rights conflict | Can block distribution or harm publishers | Begin with controlled rights and conduct partnership/legal review |
| Personalization feels invasive | Voice/history data is sensitive | Data minimization, explicit settings, clear deletion, explain relevance |
| Visual ambition hurts performance | Heavy motion can delay or distract from audio | Progressive effects, device testing, Reduce Motion, audio-first priority |

## 20. Open questions for the owner

### Highest-priority next decisions

1. Which RSS feeds should V1 support first, and should an episode without a usable `podcast:transcript` link be excluded, remain playable without exploration, or receive a privately generated fallback transcript?
2. What content can the prototype legally stream, transcribe, transform, and use for ad skipping?
3. Where should exact ad boundaries come from: publisher metadata, manually authored test markers, preprocessing/classification, or a partner service?
4. Does “skip ad” require tapping the microphone in V1, just like questions, or is it expected to be hands-free?
5. If no verified ad boundary exists, should Murmur refuse, offer a conventional time jump, or ask what to do?
6. How should the listener signal that an exploration is finished, and what should happen after inactivity?
7. Which outside knowledge, live sources, citations, and calculation tools may Murmur use for factual or quantifiable debate?
8. What default depth should each intent class use, and should the listener set a global preference in addition to saying “shorter” or “go deeper”?
9. Which matters first for the prototype: iPhone or web? What must be at parity?

### Product and experience

10. Which visible playback, discovery, queue, exploration, and recovery controls belong in V1, and which should remain voice shortcuts?
11. Should Home and Now Listening be two distinct surfaces or one transforming environment?
12. How long should the personalized greeting be, and should it ever start automatically?
13. What personality, gender presentation, accent, and sonic cue should define Murmur's voice?
14. Should the return point be exact, or should Murmur replay a short lead-in for context?
15. What other voice intents are essential after skip and exploration—resume, replay, save, follow, or play next?
16. Which languages are required first?

### Data, platform, and business

17. Is an account required, optional, or deferred? Must history sync between devices?
18. How long may raw voice, transcripts, exploration sessions, questions, answers, and listening history be retained?
19. Is background and lock-screen playback required in the first validation build?
20. Which podcast catalog, STT, LLM, TTS, retrieval, hosting, and analytics providers are acceptable?
21. What business model aligns ad skipping with creator/publisher economics?
22. What regions, age groups, and accessibility commitments define the first release?

## 21. Decision log

| Date | Decision | Reason/source | Status |
|---|---|---|---|
| 2026-09-06 | Murmur is a podcast consumption experience, not a creation tool | Owner's product description | Confirmed |
| 2026-09-06 | Voice is a first-class navigation and control layer alongside clickable/tappable UI | Owner clarification | Confirmed |
| 2026-09-06 | Home opens as one immersive inline voice surface, with the central listening aura as its primary tap and voice interaction | Owner's updated Home reference | Confirmed |
| 2026-09-06 | Home's bottom podcast covers are a dim, gently drifting decorative rail rather than a focused or interactive carousel; the player remains multimodal | Owner's updated Home reference | Confirmed |
| 2026-09-06 | V1 question interruption begins with a microphone tap | Ambient activation was explicitly deferred | Confirmed |
| 2026-09-06 | Validate exact ad skipping before the contextual exploration handoff | Owner's stated implementation order | Confirmed |
| 2026-09-06 | AI answers must be clearly distinguishable from podcast audio | Trust requirement | Confirmed |
| 2026-09-06 | Inquiry is a potentially deep, multi-turn experience spanning clarification, quantitative debate, and philosophical or abstract questions | Owner clarification | Confirmed |
| 2026-09-06 | Response depth depends on intent: actions receive minimal feedback, while concept explanations receive more context and detail without becoming verbose | Owner clarification | Confirmed |
| 2026-09-06 | The visual direction is premium, dark, media-led, and Netflix-inspired without copying it | Owner's design direction | Confirmed |
| 2026-09-06 | The product foundation targets iPhone through Expo and the web | Original project direction | Confirmed |
| 2026-09-06 | Use podcast RSS feeds and their episode-level `podcast:transcript` links as the source of publisher-supplied transcripts | Owner direction | Confirmed |
| 2026-09-06 | Use controlled RSS feeds with asset-matched timed transcripts and ad markers for the first proof | Feasibility recommendation | Proposed; owner approval needed |
| 2026-09-06 | Begin implementation and keep the owner updated with sanity checks | Owner direction | Confirmed |
| 2026-09-06 | Use a bundled, programmatically generated audio fixture for exact skip testing and a public transcript-enabled RSS feed for development discovery only | First implementation slice | Implemented for prototype |
| 2026-09-07 | Home uses a static loaded aura before speech, then speech-reactive motion with the listener's transcript inside the aura | Owner's reference and state clarification | Implemented and verified |
| 2026-09-07 | Home's bottom artwork is two independently scrolling horizontal rows moving in opposite directions, with center enlargement | Earlier owner visual direction | Superseded by the full-screen field below |
| 2026-09-07 | When native transcription is unavailable, fail before recording and expose typed or keyboard-dictation recovery rather than looping retries | Earlier recovery direction | Superseded by voice-only recovery below |
| 2026-09-07 | The controlled Handoff demo exposes a visible sponsored state and uses the asset-matched `12s–20s` marker for exact skip validation | Owner's ship-today validation goal | Implemented and verified |
| 2026-09-07 | Natural-language request entry is voice-only; remove keyboard, typed-request, and dictation-fallback surfaces while retaining direct tappable controls | Owner's updated interaction direction | Confirmed and implemented |
| 2026-09-07 | Home uses a clean full-screen matrix of consistently sized artwork tiles; adjacent rows travel in opposite directions at independent, mild speeds | Owner's updated visual reference | Confirmed and implemented |
| 2026-09-07 | Resting is a dedicated dormant glass sphere; tapping transforms it into an ethereal ribbon aura whose breathing, counter-rotation, bloom, meter, and growth become speech-responsive | Owner's corrected state and motion direction | Confirmed and implemented |
| 2026-09-07 | Visible transcription is limited to the latest two lines while the complete utterance remains available to intent routing | Owner's transcription constraint | Confirmed and implemented |

## 22. Ready-to-build checklist

- [x] Product promise is captured.
- [x] Primary audience is drafted.
- [x] The interaction principle is confirmed: natural-language requests are voice-only; direct clickable/tappable controls remain supported.
- [ ] The exact visible control inventory for V1 is agreed.
- [x] RSS feeds and `podcast:transcript` links are confirmed as the primary transcript source.
- [ ] Missing, untimed, inaccessible, and malformed feed transcript behavior is decided.
- [ ] Version 1 catalog and content rights are agreed.
- [ ] Ad-boundary source and missing-marker behavior are decided.
- [ ] Exploration knowledge sources, attribution, depth controls, and return behavior are decided.
- [x] The high-level action-versus-explanation response policy is captured.
- [ ] Default response depth and timing for each intent class are validated with listeners.
- [ ] Version 1 scope is explicitly approved.
- [x] Main user journeys are drafted.
- [x] Core experience states and major failure modes are documented.
- [x] Initial visual direction and reference are captured.
- [x] The Home interaction and ambient cover-rail direction are confirmed.
- [ ] Final visual/sonic identity is approved.
- [ ] iPhone/web priority and platform differences are decided.
- [ ] Accounts, retention, privacy, and integrations are decided.
- [ ] Business/rights implications of ad skipping are accepted or resolved.
- [ ] Remaining open questions are explicitly accepted or resolved.
- [x] The owner has explicitly approved implementation.

---

## Next instruction

Configure the server transcription credential and run the physical-microphone flow on an iPhone: speak “Play The Handoff,” enter the sponsored segment, speak “skip ad,” and confirm the `0:20` handoff. Then proceed to the contextual exploration handoff and production speech, persistence, and content-rights architecture.
