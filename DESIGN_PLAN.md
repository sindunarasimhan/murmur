# Murmur Design Plan

> Annotation doc for product/design direction. Keep notes concrete: what should be visible, how it should move, what state it represents, and what should be removed.

## 1. Design north star

Murmur should feel like a premium, cinematic, voice-led podcast listening app. The interface should keep people inside the listening experience while still allowing selected tappable UI for navigation, playback, recovery, settings, and accessibility.

The app is not “no UI.” It is low-chrome, high-atmosphere, voice-forward UI.

## 2. Homepage direction

The homepage should open into a full-screen voice surface:

- Brand lockup in the top-left.
- Lightweight settings affordance in the top-right.
- A central smokey glass orb as the primary interaction object.
- Podcast artwork behind the orb as atmospheric background, not a conventional content carousel.
- Very limited text.
- No writing or typed request surface.

### Background artwork field

The podcast thumbnails should feel like a designed wall of listening possibilities.

- Use recognizable/popular podcast artwork where available.
- Artwork should be large enough to read as premium covers, not tiny tiles.
- Covers should be semi-dimmed behind the orb.
- Grid should be tighter, with reduced row and column gaps.
- Rows should drift horizontally at mild velocity.
- Adjacent rows should move in opposite directions.
- Movement should be continuous and subtle, not distracting.

### Central orb

The orb is the product metaphor: a smokey glass listening object.

Resting state:

- Calm dark glass sphere.
- Internal smoke should move gently, not sit static.
- Text should remain readable.
- No cheap circular orbit animation.
- Smoke should feel like amorphous particles bouncing and morphing inside glass.

Listening state:

- Orb brightens and grows more alive after tap.
- Pink/orange aura should intensify.
- Internal smoke motion should become more visible and responsive.
- The state should clearly communicate “microphone is open.”

Transcription state:

- User speech should appear in a separate transcript section below the orb while the user is speaking.
- The orb itself should continue to say something like “I’m listening” so the user has clear feedback that Murmur is actively hearing them.
- The user transcript section should animate in cleanly during speech and animate out once the user pauses or capture ends.
- Cursor/typing treatment may be used only as feedback, not as a writing affordance.

System response state:

- After Murmur understands the request, the user transcript section disappears.
- The orb takes center again.
- Murmur speaks back and shows its own response text inside the orb.
- System response text inside the orb should show no more than two visible lines.
- The full system answer can exist in state for accessibility/history, but the main orb only shows the current two-line response moment.

## 3. Voice states

| State | Purpose | Visual direction | Copy direction |
|---|---|---|---|
| Resting | App is loaded and ready | Dark smokey glass orb, slow internal motion | “Hey there.” / “What would you like to listen to?” |
| Listening | Mic is open | Brighter halo, active smoke, meter motion | “I’m listening.” / “Go ahead.” |
| Transcribing | User is speaking or speech was captured | Transcript inside orb, two lines max | User’s words only |
| Processing | Murmur is deciding action/answer | Subtle pulse/loading energy | Very short status |
| Acting | Murmur performs command | Minimal transition | No verbose narration |
| Explaining | Murmur answers a question | Distinct AI-response state | Detail proportional to question |
| Error | Something failed | Calm recovery state | Clear retry/settings/cancel guidance |

## 4. Detail/listening page direction

The detail/listening page is the second major product surface after the homepage. It should not look like a conventional podcast player. When a podcast is playing, the surface should be almost entirely voice-led.

### Playback surface

- Use the current podcast cover as the background.
- The cover should be low-opacity, atmospheric, and treated similarly to the homepage artwork field.
- Motion can include a very gentle zoom, drift, or parallax treatment.
- The animation should signal that podcast audio is active without becoming a visual distraction.
- The foreground should be the voice surface, not playback controls.
- Do not show play, pause, skip, speed, scrubber, or transport chrome as primary UI.
- The only prominent interaction should be a clear voice ingress to ask Murmur about the stream or issue a command.
- Any required navigation/recovery affordance should be minimal and secondary.

### Voice interruption pattern

The detail page should reuse the homepage voice behavior so the product feels like one coherent system.

1. Podcast is playing.
2. A quiet readiness line says `SAY “HEY MURMUR” TO INTERRUPT` when foreground wake listening is connected.
3. User says “Hey Murmur” or taps the voice ingress.
4. Podcast pauses and the current timestamp is protected.
5. Orb moves into listening state.
6. User transcript appears in a separate section below the orb; the visible request excludes the wake phrase.
7. Orb says “I’m listening” or equivalent while the user speaks.
8. When the user stops speaking, the transcript section animates away.
9. Orb becomes the response surface.
10. Murmur/system response appears inside the orb, capped to two lines.
11. Murmur speaks in its distinct AI voice.
12. User can ask another question or return to the podcast stream.

### Skip-ad interaction

The skip-ad path should feel like a clean voice command, not a media-control workaround.

- User interrupts during an in-stream ad and says “skip ad” or equivalent.
- Murmur identifies the command.
- If the ad boundary is verified, the page should show a short action state.
- A pleasant chime/ting confirms completion.
- The podcast resumes from the post-ad boundary.
- Visual feedback should be elegant and brief: no verbose explanation unless skipping is unavailable.
- If no verified ad marker exists, Murmur should fail gracefully and not guess.

### In-stream question interaction

The ask-question path should make the interruption feel safe and reversible.

- User interrupts mid-stream with a clarifying question.
- Murmur keeps the episode timestamp and transcript context.
- User transcript appears below the orb only during capture.
- Murmur response appears inside the orb while spoken.
- The response should be helpful but not overly verbose.
- The user can continue the conversation or return to the stream.
- Returning should feel like a handoff back into the original podcast, not like exiting a chatbot.

### Context and personalization

Murmur should become more contextually relevant over time.

- Welcome notes should become more relevant as Murmur learns what the user plays, skips, resumes, and asks about.
- Recommendations should reflect listening behavior and question behavior, not only generic popularity.
- The app needs a durable place to save lightweight user preference/context signals.
- Context should help Murmur understand where the user is coming from without making the interface feel heavy or creepy.
- Contextual greetings should stay concise and useful.

## 5. Response design

Murmur should distinguish actions from explanations.

- Actions: perform quickly with little or no speech.
- Concept clarification: enough detail to be useful.
- Quantifiable/factual analysis: show reasoning and uncertainty.
- Debate/counterargument: compare assumptions clearly.
- Philosophical/abstract questions: allow more depth without rushing back.
- Personal recommendations: use remembered listening/question context, but keep the explanation short.
- Welcome notes: contextual and relevant, not long.

## 6. Current design QA checklist

- [ ] Homepage matches the provided orb/grid references closely.
- [ ] Background covers are large, legible, dimmed, and moving row-by-row.
- [ ] Adjacent artwork rows move in opposite directions.
- [ ] Resting orb has visible internal smoke motion.
- [ ] Listening orb visibly brightens and animates after tap.
- [ ] User transcript appears below the orb during capture, then animates out.
- [ ] System response appears inside the orb and stays to two lines.
- [ ] No typed request/dictation fallback is visible.
- [ ] Detail page feels like a voice-only playback surface, not a conventional player.
- [ ] Detail page voice interaction uses the same full-screen system.
- [ ] Active playback clearly but quietly communicates when “Hey Murmur” is ready.
- [ ] Wake activation and tap activation enter the same listening/transcription design states.
- [ ] Podcast cover background is low-opacity and gently animated during playback.
- [ ] Skip-ad completion has a tasteful chime/ting and brief visual confirmation.
- [ ] Motion respects reduced-motion settings.

## 7. Open design questions

- Exact brand typography and type scale.
- Final podcast artwork rights/source for launch catalog.
- Whether the first screen should greet silently, speak after tap, or speak after an explicit start gesture.
- Final treatment for assistant-speaking state after a question.
- Sound design: listening cue, skip confirmation, return-to-podcast cue.
- Where lightweight user preference/context should be stored for prototype and production.
