# InnerVoice

A low-latency prototype of a cognitive-augmentation writing tool: as you type,
InnerVoice quietly anticipates where your thought is going and whispers a
short continuation back to you, in your own voice, over headphones.

```
You type → 400ms pause → LLM predicts 10–15 words → TTS streams audio → whispered back
```

If you keep typing, the whisper fades out instantly so it never fights your
flow.

## Architecture

```
innervoice/
├── backend/
│   ├── main.py       # FastAPI app: /api/predict streams MP3 bytes back
│   ├── config.py     # env var / API key handling, provider resolution
│   ├── llm.py        # OpenAI (gpt-4o-mini) / Anthropic (claude-haiku-4-5)
│   ├── personas.py   # persona registry: system prompts for InnerVoice/Mentor/Friend/Demon
│   └── tts.py         # ElevenLabs / Cartesia streaming TTS
├── frontend/
│   ├── index.html    # distraction-free dark-mode editor (Tailwind)
│   └── app.js         # debounce, request lifecycle, MSE audio playback
├── requirements.txt
└── .env.example
```

### Request lifecycle (one typing pause)

1. `frontend/app.js` listens to the `<textarea>`'s `input` event. Every
   keystroke resets a 400ms debounce timer **and** immediately fades out /
   stops any whisper currently playing — typing always wins.
2. When the debounce timer fires, the frontend extracts just the
   **current paragraph** under the cursor (text between the nearest blank
   lines) and `POST`s it to `/api/predict`.
3. The backend (`backend/main.py`) asks a fast LLM
   (`backend/llm.py`) to continue that thought in 10–15 words, with a hard
   word-count clamp as a safety net.
4. The backend immediately starts streaming that phrase through a TTS
   provider (`backend/tts.py`) and pipes the MP3 bytes straight back to the
   client as they're generated — nothing is buffered server-side, which is
   what keeps time-to-first-audio-byte low. The predicted text itself is
   echoed back in an `X-Predicted-Text` response header.
5. The frontend appends incoming bytes into an `<audio>` element via the
   **Media Source Extensions API** (`MediaSource` + `SourceBuffer`), so
   playback starts the moment the first chunk lands rather than waiting for
   the whole clip. A small caption briefly shows the whispered phrase for
   visual confirmation (not required, but nice for demos/debugging).
6. Every request/stream carries a monotonically increasing "token". The
   moment a newer typing pause supersedes an older one, the older stream's
   read loop notices (`isStale()`) and quietly stops appending/playing —
   this is what makes "resume typing → audio stops" instant and glitch-free.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
```

Then open **`.env`** (not `.env.example`) and add ONE LLM key + ONE TTS key:

```
OPENAI_API_KEY=...           (or ANTHROPIC_API_KEY=...)
ELEVENLABS_API_KEY=...       (or CARTESIA_API_KEY=... + CARTESIA_VOICE_ID=...)
```

> ⚠️ **Never put real keys in `.env.example`.** Only `.env` is listed in
> `.gitignore` — `.env.example` is meant to be committed as a template, so
> anything you put there could end up in git history / a shared repo.
>
> Also, if you're on zsh: `cp .env.example .env  # some comment` will *not*
> treat `# ...` as a comment by default (zsh doesn't enable
> `INTERACTIVE_COMMENTS` out of the box), so that trailing text gets passed
> to `cp` as extra arguments and can silently corrupt the copy. Keep
> comments on their own line, as above.

For the "whispers back in their own voice" effect, clone your own voice in
ElevenLabs (Voice Lab → Instant Voice Clone) or Cartesia (Voice Cloning) and
put that voice's ID in `ELEVENLABS_VOICE_ID` / `CARTESIA_VOICE_ID`.

## Run

```bash
uvicorn backend.main:app --reload --port 8000
```

Open **http://localhost:8000** — the backend also serves the frontend
directly, so there's nothing else to start. Just start typing; after a beat
of silence you should hear the whisper.

> Note: browsers require a user gesture to unlock audio playback.
> `app.js` primes the `AudioContext` on your very first keypress so this
> never surfaces as a real-world issue.

## Latency notes / tuning knobs

- **Debounce**: 400ms, in `frontend/app.js` (`DEBOUNCE_MS`). Lower = more
  eager/interruptive, higher = calmer but slower to respond.
- **LLM speed**: `gpt-4o-mini` / `claude-haiku-4-5` are both sub-second for a
  ~15-word completion. `max_tokens` is capped at 40 to avoid any runaway
  generations.
- **TTS speed**: ElevenLabs `eleven_turbo_v2_5` with
  `optimize_streaming_latency=4` (max) is used by default; swap models in
  `.env` if you want higher fidelity at the cost of latency. Cartesia's
  `sonic-2` streamed via `/tts/bytes` is a drop-in alternative.
- **Audio playback**: streamed via MSE so the first audible sound doesn't
  wait for the full clip to download. Falls back to full-blob playback on
  browsers without MP3 MSE support (e.g. Safari).
- **Interruption**: stopping is a 150ms linear gain fade (`FADE_OUT_SECONDS`
  in `app.js`), not a hard cut — avoids an audible click while still feeling
  instantaneous.

## Persona steering (experimental, `cursor/persona-steering` branch)

The wordmark now doubles as a control: a small vertical slider next to
"Inner_____" lets you morph the whisper's *intent*, not just its wording.
Each position swaps the LLM system prompt used for the continuation
(`backend/personas.py`):

| Slider position | Persona | Steers toward |
|---|---|---|
| 0 | **InnerVoice** (default) | quiet, intuitive continuation of your own thought |
| 1 | **InnerMentor** | clarity, growth, constructive next steps |
| 2 | **InnerFriend** | warmth, validation, casual encouragement |
| 3 | **InnerDemon** | cynicism, self-doubt, harsh (but never harmful) critique |

The frontend fetches the persona list from `GET /api/personas` (id/label/
tagline only — system prompts stay server-side) and sends the selected
persona's `id` alongside the text in each `POST /api/predict` call. The
chosen persona is remembered per-browser via `localStorage`.

`InnerDemon`'s prompt includes an explicit safety rail instructing the model
to stay cynical/critical but never suggest self-harm, violence, or genuinely
abusive language — it's meant to model a harsh inner critic, not a threat.

To add a new persona, add one `Persona(...)` entry (id, label, tagline,
system_prompt) to `PERSONAS` in `backend/personas.py`; the slider range and
frontend list pick it up automatically, no other file needs to change.

## Future work

- **Chain streaming end-to-end**: right now the backend waits for the full
  (short) LLM completion before starting TTS. For even lower latency, you
  could stream LLM tokens directly into Cartesia's WebSocket TTS API
  (`ctx.push(token)` per partial sentence chunk) so speech synthesis begins
  before the LLM has finished generating.
- **Smarter "pause" detection**: currently a fixed 400ms silence window;
  could be adapted based on typing cadence or sentence-boundary heuristics.
- **Persisted voice profile**: store the user's cloned voice ID per-user
  once this moves beyond a single-user prototype.
