# InnerVoice Research Roadmap

Notes from a feedback session with Sun on how to take InnerVoice further as a
research project, organized into concrete questions, related work, and next
steps. Three of these (#2, #3, #4) now have config-gated prototype features
to make them testable in real sessions — see the "Prototype hook" note under
each. The rest (#1, #5, #6, #7) are framed as study designs for now.

## 1. Does the voice stay in your mind after you unplug?

**Question.** After a session of using InnerVoice, does the whispered voice
linger — do people keep "hearing" it, or does their inner monologue snap back
to its normal register? Anecdotally, people who use ChatGPT a lot report
their own thoughts starting to sound like autocomplete.

**Related work.** MIT Media Lab's own
[*Your Brain on ChatGPT: Accumulation of Cognitive Debt When Using an AI
Assistant for Essay Writing Task*](https://www.media.mit.edu/publications/your-brain-on-chatgpt/)
(Kosmyna et al., 2025) is the closest existing study. Using EEG across four
months, they found LLM-assisted writers showed the weakest brain
connectivity of three groups (LLM / Search Engine / Brain-only), the lowest
self-reported essay ownership, and — most relevant here — a fourth session
where LLM users were reassigned to a "Brain-only" condition ("LLM-to-Brain")
and showed *reduced* alpha/beta connectivity, i.e. measurable
under-engagement carried over after the tool was removed. That's
structurally the same question as "what happens when you unplug from
InnerVoice," just measured with EEG instead of self-report.

**Hypothesis.** Short InnerVoice sessions produce a measurable "linger"
effect: immediately after unplugging, people's freely-written continuations
will show lexical/stylistic convergence toward the whispered continuations
they heard, decaying over some time window.

**Proposed study design.**
- Within-subject: writing session with InnerVoice on, then immediately
  after, a writing session with it off (same or matched prompt).
- Compare n-gram overlap / stylistic similarity between (a) InnerVoice's
  whispered completions and (b) the participant's own unaided continuations
  right after unplugging, decaying over subsequent minutes.
- Lightweight self-report probe, logged via the same event beacon used for
  duration research (see #3's prototype hook): a single Likert item
  ("does this continuation still feel like it was your own thought, now that
  the audio's stopped?") fired at natural idle points and again post-session.
- Heavier follow-on: adapt Kosmyna et al.'s post-session interview + essay
  ownership questions directly to InnerVoice sessions.

## 2. Teleabsence: talking to a different version of yourself, or someone not present

**Question.** Would it feel natural to have InnerVoice whisper back in the
voice of a younger/older you, or someone who isn't physically present, not
just "your own" undercurrent voice?

**Related work.** This is literally the subject of two MIT-adjacent
projects that land on opposite sides of a key design choice:
- [*TeleAbsence: A Vision of Past and Afterlife Telepresence*](https://www.media.mit.edu/articles/teleabsence/)
  (MIT Media Lab, Tangible Media group) extends telepresence to absent/past
  people, but its five design principles (presence of absence, illusory
  communication, materiality of memory, traces of reflection, remote time)
  explicitly *avoid* literal or generative recreation of a specific person's
  voice/utterances — it argues for poetic, non-synthetic traces instead, and
  is wary of "ghost bot" style generative avatars.
- [*Future You: A Conversation with an AI-Generated Future Self Reduces
  Anxiety, Negative Emotions, and Increases Future Self-Continuity*](https://arxiv.org/html/2405.12514)
  takes the opposite stance: an LLM-generated, voice-cloned conversational
  future self, and finds it *reduces* anxiety and increases future
  self-continuity.

**Open design question.** InnerVoice's teleabsence persona(s) need to pick a
side of this tension: literal generative recreation (closer to *Future
You*, higher fidelity, but treads on TeleAbsence's ethical concerns
especially for a specific absent/deceased person) vs. a deliberately generic,
non-identifying "someone who isn't here right now" framing (closer to
TeleAbsence's stance, safer, but maybe less emotionally resonant).

**Prototype hook.** `backend/personas.py` now includes two teleabsence-style
personas — `InnerFutureSelf` (continuity-of-self framing, modeled on *Future
You*'s approach) and `InnerAbsent` (a generic, non-identifying "someone not
physically here with you" voice, deliberately avoiding impersonation of a
specific real person, per TeleAbsence's stance). Both are selectable from
the existing persona carousel with no other prototype changes needed.

**Proposed study design.** Short semi-structured sessions comparing the
default `Voice` persona against `InnerFutureSelf` / `InnerAbsent`, probing:
does it feel natural, does it feel like "your" thought or someone else's,
and does the emotional register (comfort vs. uncanny) differ from the
literature's two takes above.

## 3. What is the ideal whisper duration?

**Question.** Sun suggested duration should vary with the prompt / the
words being typed, and that gauging InnerVoice's accuracy matters — how many
words someone types should predict the ideal length of the whispered
continuation.

**Prototype hook.** The previously-fixed "10 to 15 words, always" clamp is
now adaptive: `backend/config.py` exposes `duration_words_per_input_word`,
`min_continuation_words`, and `max_continuation_words` as env-tunable knobs,
and the target word count scales with how many words the user has typed in
the current paragraph (short fragment -> short whisper; longer paragraph ->
a longer, still-capped whisper). `backend/llm.py` computes this target range
per-request and both instructs the model with it and hard-clamps the result
as a safety net, same as before.

Every request now also gets logged (`backend/session_log.py`, JSONL under
`logs/`) with: input word count, computed target range, actual predicted
word count, persona, and — via a new fire-and-forget `POST /api/event` beacon
from `frontend/app.js` — whether the user interrupted the whisper before it
finished playing. That interruption signal is a cheap proxy for "this
went on too long / didn't match what I wanted to hear next."

**How this answers the research question.** Accuracy scoring itself needs
human judgment (does the whisper match what the person "would have thought
next")—that's not something to fake in real time. Instead, the logging
above builds the raw dataset — input length vs. chosen duration vs.
interruption/completion — that a later offline pass (human ratings, or an
LLM-as-judge pass like the one used in the *Your Brain on ChatGPT* study)
can use to fit an actual "ideal duration curve" instead of guessing at
scaling constants.

## 4. Utility: when and how should InnerVoice show up?

**Question.** Several sub-questions bundled together: should InnerVoice
fire in voice only, or text too? Should the on-screen predicted-text caption
be erased once the whisper finishes? Does the context window need to grow
to remember past whispers, and if people don't re-read the caption anyway,
can it be safely removed?

**Prototype hooks.**
- **Caption visibility toggle** — `backend/config.py`'s `show_caption` flag
  (default on) is exposed via a new `GET /api/config` endpoint;
  `frontend/app.js`'s caption logic becomes a no-op when it's off. This
  makes "do people actually need to see the text, or does the audio alone
  carry the thought" directly A/B-testable rather than a debate.
- **Whisper memory (context window growth)** — previously every
  `/api/predict` call only ever saw the *current* paragraph, with zero
  memory of what was already whispered. `enable_whisper_memory` (off by
  default) turns this on: the frontend keeps the last few whispered
  continuations in memory and sends them as `history` in the predict
  request; `backend/llm.py` folds them into the prompt as prior
  "already-said" turns so the model can build on, not repeat, what it
  already whispered. This is a direct, flippable answer to "does the
  context window need to grow to store this conversation."
- Both flags are logged per-request in `session_log.py` so any observed
  effect (e.g. fewer interruptions, different self-reports) can be tied
  back to which condition was active.

**Still open (not prototyped this round).** Voice-only vs. text-triggered
InnerVoice is a bigger input-modality question — the current prototype is
text-in only, so "should it also fire off a spoken trigger" needs a speech
pipeline before it's testable at all. Flagged as future work alongside #7.

## 5. Which interaction loop comes first: innervoice, or the prompt?

**Question.** Contrasting interaction loops: (a) the common
video-prompt-in / voice-out pattern ("point phone at something, ask what it
is, AI speaks back"), (b) Sun's voice-prompt-in / voice-answer-out, and (c)
InnerVoice's own inner-thought -> typing -> inner-thought-out loop.
Hypothesis: the innervoice happens *before* any of these — you already have
an inner voice before you even lift your phone to ask a question out loud —
so seamlessly filling in that pre-verbal innervoice could matter more than
any of the explicit-prompt patterns.

**Proposed study design.** A think-aloud / experience-sampling comparison:
have participants use a voice-assistant-style tool (prompt in, voice out)
and InnerVoice back-to-back on comparable tasks, and probe specifically for
*when* they report first "having" the thought relative to when they acted
on it (typed, spoke, or reached for the phone). The goal is to test whether
people can reliably report an inner-voice moment that precedes the overt
prompt, which would support treating InnerVoice as a *pre-prompt* layer
rather than a competing modality to voice assistants.

## 6. What qualifies as an innervoice, and when does it occur?

**Question.** How common is inner speech in the first place, what changes
when you augment or change it, and does it only occur in quiet-room,
low-stimulation settings — or elsewhere too?

**Related work / next step.** This maps onto existing inner-speech
psychology literature — most notably work using the *Varieties of Inner
Speech Questionnaire* (VISQ) and related self-report instruments that
already characterize dialogic vs. monologic inner speech, its evaluative
tone, and how much people report experiencing it day to day. Before running
new InnerVoice studies, it's worth a short literature scan of that
inner-speech-frequency/phenomenology literature rather than re-deriving
baseline prevalence numbers from scratch.

**Proposed screening question set for future participants** (to run before
any InnerVoice session, so results can be segmented by baseline inner-speech
profile):
- How often do you notice an "inner voice" narrating or rehearsing thoughts?
- In what settings does it feel strongest/quietest — alone, in a quiet room,
  while walking, in conversation, etc.?
- Does it ever feel like someone else's voice, or always your own?
- Has using AI tools (chat, autocomplete, voice assistants) changed how that
  inner voice sounds or how often you notice it?

## 7. Filtering / amplifying innervoice in group settings

**Question.** Personal pain point: ideating or working in a group is hard
because others' voices interrupt your own inner voice. Would a way to filter
out or amplify your innervoice in that setting help you think or ideate
better?

**Why not prototyped this round.** This needs a fundamentally different
input than the current text-only prototype — it implies picking up ambient/
external audio (other people talking) and having InnerVoice suppress or
compensate for it, which is a real-time audio-filtering + attention problem,
not a config flag on the existing text pipeline. Flagged as a larger
follow-on project.

**Proposed direction for later.** Two distinct mechanisms worth separating
in a future design: (a) *masking* — playing your own InnerVoice whisper at a
level/timing that helps it "win" perceptually over ambient conversation
(closer to attention/auditory-masking research), vs. (b) *amplifying* —
actively surfacing more/longer innervoice continuations specifically when
ambient noise is detected, on the theory that group settings are exactly
when your own train of thought needs the most external scaffolding to
survive. Both would need a live-audio-input version of the prototype to test
at all.

## 8. Proxy ideation: seeding someone else's inner voice on your behalf

**Question.** Could InnerVoice be used to get a specific collaborator
thinking about *your* idea, by playing them a whispered continuation of
your prompt in a voice that primes their own inner monologue to pick it up
— then following up with them once they've had time to think it through?

**Important reframe — read before building anything here.** The version of
this idea that was raised (clone a specific named person's voice, e.g. a
friend "Timothy," and play them a whisper about your research *without
their knowledge*, on the theory that hearing "their own" inner voice will
covertly hijack their thinking) is **not something to build**, for reasons
worth stating plainly rather than working around:

- Both TTS providers this prototype uses (ElevenLabs, Cartesia) require
  the voice owner's own consent to clone their voice at all — cloning
  someone else's voice without them knowing is a straightforward ToS
  violation before any research-ethics question even comes up.
- Covertly trying to influence a specific person's cognition, without
  their knowledge or consent, is squarely the kind of deception a human-
  subjects review would block — this is qualitatively different from every
  other item in this roadmap, which are all about augmenting *your own*
  cognition, or a collaborator's cognition *with their knowledge*.
- Even outside a formal research context, someone finding out their voice
  was cloned to plant thoughts in their own head without being told is the
  kind of thing that damages trust regardless of intent, and plausibly
  runs into voice/likeness right-of-publicity or recording-consent issues
  depending on jurisdiction.

**The testable hypothesis underneath this is still interesting, though:**
*hearing a prompt narrated in your own (or your habitual) inner voice makes
you elaborate on it more than reading it, or hearing it in a stranger's
voice, would.* That's answerable with an opt-in design instead of a covert
one:

- The collaborator (Timothy) is told exactly what's happening and opts in.
- He provides his own voice sample (a consensual clone) or just uses
  InnerVoice's default/his own cloned voice already on file for his own
  use — never a voice captured or cloned without his participation.
- You send him a prompt (your research question/idea). InnerVoice whispers
  it back to *him*, in his own consensually-provided voice, while he
  free-writes or thinks out loud.
- You follow up with him directly afterward — a normal conversation, not a
  covert readout of his unwitting internal reaction.

This preserves the actual research question (does hearing a prompt in
"your own" inner voice seed deeper ideation than other input channels do)
while making the collaborator a full participant rather than a target.

**Not prototyped this round** — flagged here so the idea is captured and
the ethical guardrail is explicit, but it needs a deliberate "invite a
collaborator" consent flow (who's providing the voice sample, how it's
stored, how they see/approve what gets sent to them) designed before any
code, not bolted on after.

## 9. Multiplayer innervoice: triaging other people's voice messages via a grounded proxy agent

**Question.** People send voice messages/responses that are slow to listen
to and tiring to transcribe-and-read. Could each sender have an agent that
holds the content of what they actually said, so you can "talk to them"
conversationally — including follow-up questions — without them needing to
be present, and hear the answers back in a voice?

**Reframing before any design.** This is a different, more tractable
problem than roadmap item #8, and it's worth being precise about why. #8
was risky because it involved playing someone *their own* cloned voice to
try to influence *their* thinking, without their knowledge. This idea is
the opposite direction: someone already, deliberately, sent *you* a
message; you want help processing and querying it. The part that needs
care is narrower and specific: if the "agent" answers a follow-up question
the sender never actually addressed, and reads that answer back in the
sender's own cloned voice, you get a fabricated statement that sounds
exactly like them saying something they never said. That's a
**misattribution problem**, not a manipulation problem — solvable with
design, not something to avoid entirely.

**Related work / grounding.**
- Danaher & Nyholm's **Minimally Viable Permissibility Principle (MVPP)**
  for personalized digital duplicates ([*The ethics of personalised digital
  duplicates*](https://link.springer.com/article/10.1007/s43681-024-00513-7))
  proposes five conditions for any digital duplicate to be permissible:
  **consent**, **minimal positive value**, **transparency**, **harm
  mitigation**, and **contextual integrity** — a ready-made checklist for
  this feature.
- [*Cognitive Digital Twins: Ethical Risks and Governance for AI Systems
  That Model the Mind*](https://arxiv.org/html/2606.23094) (2026) defines
  exactly this class of system — "a communicative or decision-making
  proxy" for a specific person — and proposes a 5A governance frame
  (authority, autonomy, access & control, accountability, availability);
  worth reusing rather than inventing guardrails from scratch.
- [*From Role to Person: Trust Calibration Challenges in Twin Agents*](https://matthiasbaldauf.com/automationxp26/papers/AutomationXP26_paper_3830.pdf)
  names the exact failure mode to design around: when a "twin agent"'s
  answer seems off, there are three indistinguishable explanations from
  the outside — the model's representation is incomplete (**schema
  gap**), you don't know the real person's actual view (**epistemic
  gap**), or the model is simply fabricating. A trustworthy design needs
  to make which one is happening legible, not paper over it.
- This is not hypothetical territory — consumer tools already ship
  "digital twin" chatbots built from someone's messages/voice
  (MemoryClone, Lexikon AI, Morfoz), which is evidence this is a live,
  unresolved product-ethics space worth being deliberate about rather
  than a reason to skip the analysis.

**Proposed architecture, tiered by risk (build/enable low tiers first):**

- **Tier 0 — transcribe & search (no synthesis at all).** ASR every
  incoming voice message, store the transcript per sender, let you
  semantically search/skim it ("what did Alice say about the budget?").
  Answers are literal excerpts. Zero fabrication risk, and this alone
  solves most of "not easy to take in."
- **Tier 1 — grounded proxy agent, shared/neutral voice.** One agent per
  sender, system-prompted to answer *only* from that sender's actual
  transcripts (retrieval-grounded, not free generation) and to explicitly
  say "they didn't cover that" rather than guess when a follow-up falls
  outside what they actually said. Read back in a shared assistant voice
  (or a small set of distinct-but-not-real-person voices, à la the
  `InnerFutureSelf`/`InnerAbsent` personas) so multiple correspondents stay
  distinguishable without reusing anyone's real biometric voice identity.
- **Tier 2 — consented sender voice clone.** Only if the sender explicitly
  opts in, and only after they're told specifically what it's for: *"an AI
  assistant will read back things you've actually said in your voice, and
  will clearly mark when it's inferring beyond what you've told them."*
  Two sub-cases matter here: **direct quotes never need cloning at all** —
  just replay the original recorded audio verbatim; only genuinely
  generated/inferred answers would use the clone, and those should carry
  an explicit marker (spoken preface like "based on what they told me..."
  or similar) so you can always tell quote from inference — directly
  addressing the schema/epistemic/fabrication ambiguity above.

**Ethical guardrails, mapped to MVPP:**
- *Consent* — a sender opting into Tier 2 needs to understand their voice
  will generate new spoken content attributed to them, not just play back
  what they sent.
- *Minimal positive value* — this should measurably cut triage time (the
  stated goal), not become a novelty voice-changer.
- *Transparency* — you (and ideally the sender) can always tell literal
  quote from AI inference.
- *Harm mitigation* — the agent should decline rather than confidently
  fabricate on anything consequential (commitments, opinions you might
  repeat to a third party).
- *Contextual integrity* — stays a private triage tool between you and
  your own inbox; not repurposed so a third party could "talk to" someone
  else's proxy without that person knowing.

**Proposed next step.** Tier 0/1 (transcribe + retrieval-grounded neutral-
voice agent) raise no new ethical concerns beyond what a "chat with your
inbox" assistant already has, and directly solve the stated pain point —
this is buildable now. Tier 2 (actual sender voice cloning) needs the
consent-flow question decided first, the same way item #8's "invite a
collaborator" flow does, before any voice-cloning code gets written.

## 10. When does innervoice emerge, and does echoing it back reinforce the loop?

**Question (detection).** Can we know exactly when someone's innervoice is
about to emerge — a few milliseconds before they type, or while they're
reading over a passage — and prompt around that moment?

**Related work.** MIT Media Lab's own
[*AlterEgo*](https://www.media.mit.edu/projects/alterego/overview/)
(Kapur & Maes) is the most direct existing answer: a wearable that reads
neuromuscular subvocalization signals from the jaw and face during silent,
internal articulation and decodes the words *before* they're spoken or
typed (92% median word accuracy), closing the loop via bone-conduction
audio feedback so the whole exchange is "subjectively experienced as
completely internal... like speaking to one's self." Separately, EEG
research shows inner speech is preceded by a motor-related slow negative
wave — a contingent negative variation closely related to the readiness
potential — detectable up to roughly two seconds before articulation in
some paradigms, with its amplitude modulated by how predictable the
upcoming word is (i.e. the brain forms a forward model of the covert
"action" of speaking internally, before it happens).

**Conclusion.** Precise onset detection is a solved-ish problem — but only
with added hardware (EMG, à la AlterEgo, or EEG readiness-potential
decoding). Without new hardware, this text-only prototype only has weak
behavioral proxies: the existing 400ms typing-pause debounce
([frontend/app.js](frontend/app.js) `DEBOUNCE_MS`) already leans on one
such proxy (a pause suggests a thought has settled enough to continue),
and "reading a passage" has no software-only equivalent worth trusting
without eye-tracking (dwell time on scroll/cursor position is too noisy).
This is flagged as future hardware-integration work, not something to
prototype in software this round.

**Question (reinforcement).** Assuming a whisper has already been
produced, can *echoing it back* — first typing from your innervoice,
then hearing the AI whisper it, then watching/reading it appear again in
sync with the audio, then rereading it — reinforce the inner loop, making
the continuation feel more like it was genuinely "your" thought?

**Related work.**
- Speech-shadowing research shows that shadowing (immediately repeating
  what's heard) triggers an automatic, long-lasting "echo effect":
  listeners spontaneously converge toward the acoustic/rhythmic pattern of
  what they just heard, and these detailed episodes are retained in memory
  and shape later perception and production — mediated by the phonological
  loop of working memory.
- The **generation effect** / **production effect** in memory research:
  actively producing material during encoding (rather than passively
  reading it) reliably improves later recall, engaging a broader
  prefrontal-posterior network than passive reading does.
- Together these suggest a plausible mechanism: closing the loop with a
  *synced, re-appearing, rereadable* echo of the whisper — rather than a
  whisper that's heard once and then gone — could measurably strengthen
  whether a continuation "sticks" as the user's own thought. This is a
  candidate mechanism for item #1's linger-effect question, not a
  standalone claim.

**Prototype hook: "Echo Mode".** Instead of showing the predicted text in
the separate instant-show-then-fade caption, the whisper is now
(optionally) **typed directly into the editor**, word-by-word, in sync
with its audio — so rereading it means rereading your own draft, not a
transient overlay. If the user resumes typing before the reveal finishes,
the not-yet-typed remainder is rolled back and whatever they typed wins,
same "typing always wins" rule the audio playback already follows; once
a reveal finishes it's committed and indistinguishable from anything
typed by hand. See `enable_echo_reveal` / `echo_reveal_wpm` in
[backend/config.py](backend/config.py) and the reveal/insertion loop in
[frontend/app.js](frontend/app.js).

**Sync-precision trade-off (explicitly not solved this round).** Exact
per-word timing is already technically possible in this codebase by
reusing `synthesize_with_timestamps()` in
[backend/tts.py](backend/tts.py) — the same alignment machinery the
voice-match onboarding test uses for its karaoke-style word highlighting
([frontend/voice-match.js](frontend/voice-match.js)). It isn't used for
Echo Mode because that endpoint is **non-streaming** (it returns the full
clip only after synthesis completes), and swapping `/api/predict`'s TTS
call over to it would blunt the low-latency "instant whisper" design that
the whole prototype is built around. Echo Mode instead paces its reveal
with a simple word-count / assumed-words-per-minute estimate
(`echo_reveal_wpm`), which is not frame-accurate but doesn't cost any
latency. If the approximation feels visibly out of sync in practice,
exact-timestamp sync (accepting either the non-streaming latency hit, or
a second throwaway alignment-only TTS call) is the natural follow-up.

## Summary: prototype vs. research-only

| # | Topic | This round |
|---|---|---|
| 1 | Unplugging / linger effect | Research design only (see above) |
| 2 | Teleabsence | Prototype: `InnerFutureSelf`, `InnerAbsent` personas |
| 3 | Adaptive duration | Prototype: length-scaled word target + accuracy logging |
| 4 | Utility / screen / memory | Prototype: caption toggle + whisper-memory flag |
| 5 | Innervoice-first interaction loop | Research design only |
| 6 | What qualifies as innervoice | Research design only (+ screening questions) |
| 7 | Group-setting filtering | Future work (needs ambient-audio input) |
| 8 | Proxy ideation (consent-based reframe) | Research design only — explicit ethical guardrail against the covert version |
| 9 | Multiplayer innervoice (voice-message triage) | Research design + tiered architecture — Tier 0/1 (transcribe + grounded agent) is safe to prototype now, Tier 2 (sender voice clone) needs a consent flow first |
| 10 | Innervoice emergence + echo reinforcement loop | Detection: research-only (needs EMG/EEG hardware, e.g. AlterEgo). Reinforcement: Prototype: `enable_echo_reveal` types the whisper directly into the editor, word-by-word, in sync with its audio |
