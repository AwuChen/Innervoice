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
│   ├── main.py                     # FastAPI app: /api/predict + persona + voice onboarding routes
│   ├── config.py                   # env var / API key handling, provider resolution
│   ├── llm.py                      # OpenAI (gpt-4o-mini) / Anthropic (claude-haiku-4-5)
│   ├── personas.py                 # persona registry: system prompts for InnerVoice/Mentor/Friend/Demon
│   ├── tts.py                       # ElevenLabs / Cartesia streaming TTS
│   ├── voice_clone.py               # ElevenLabs Instant Voice Clone API wrapper
│   ├── voice_profile.py             # persisted { voice_id, voice_name } (JSON file)
│   └── voice_onboarding_content.py  # reading script for Instant Voice Clone
├── frontend/
│   ├── index.html        # distraction-free dark-mode editor (Tailwind)
│   ├── app.js              # debounce, request lifecycle, MSE audio playback
│   ├── voice-gate.js       # on load, sends the user to onboarding.html if needed
│   ├── onboarding.html     # dedicated voice-setup page (same look as the editor)
│   └── onboarding.js       # record script/prompts, POST to /api/voice/clone, navigate back
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

### Voice onboarding (record once → clone → resume the loop above)

Before InnerVoice can whisper back "in your own voice", it needs a voice to
clone. This is a one-time (or redo-able) setup step that lives on its own
dedicated page -- `frontend/onboarding.html` -- rather than a popup on top
of the editor, and it hands off into the exact same `/api/predict` loop
described above once it's done:

1. On load, `frontend/voice-gate.js` calls `GET /api/voice/profile`. If
   ElevenLabs is configured as the TTS provider and the user hasn't cloned
   a voice yet (and hasn't dismissed onboarding before), it navigates to
   `/onboarding.html` before the editor is ever shown.
2. The user **reads a single short, phonetically-varied script out loud**,
   once, via `MediaRecorder`. Onboarding intentionally asks for exactly one
   clean, consistently-delivered reading rather than mixing in separate
   free-response prompts -- an earlier version of this flow did that, but
   recordings with noticeably different delivery/tone (e.g. a deliberately
   deadpan answer) tended to introduce accent/tone drift into the clone
   instead of helping it.
3. On submit, the browser `POST`s that recording as `multipart/form-data` to
   `POST /api/voice/clone`. The backend (`backend/voice_clone.py`) calls
   ElevenLabs' `POST /v1/voices/add` (Instant Voice Clone) with that sample,
   gets back a `voice_id`, and persists it via `backend/voice_profile.py`.
4. `backend/tts.py` whispers back using the cloned `voice_id` from that
   moment on, instead of the static `ELEVENLABS_VOICE_ID` fallback.
5. The page navigates back to `/` -- the editor loads normally and the
   typing → predicting → whispering loop just resumes, now in the user's
   own cloned voice. A small "re-record voice" link stays available (top
   right of the editor) if they want to redo it later.

This only activates for the ElevenLabs provider (Instant Voice Clone is an
ElevenLabs feature); if Cartesia is configured instead, `supported: false`
comes back from `/api/voice/profile` and onboarding stays out of the way
entirely, relying on the statically configured `CARTESIA_VOICE_ID`.

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

For the "whispers back in their own voice" effect: if you're using
ElevenLabs, just open the app and follow the in-browser voice onboarding
flow described above the first time (it needs microphone access) --
Instant Voice Clone runs automatically and you're done. If you're using
Cartesia, or want to skip onboarding, clone a voice manually (ElevenLabs
Voice Lab → Instant Voice Clone, or Cartesia → Voice Cloning) and put that
voice's ID in `ELEVENLABS_VOICE_ID` / `CARTESIA_VOICE_ID` instead.

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

## Deployment

InnerVoice requires a server to run the Python backend (it cannot be deployed to
static hosting like GitHub Pages). The following platforms support this
application with minimal configuration.

### Render (recommended)

1. Fork or push this repo to GitHub.
2. Create a new **Web Service** at [render.com](https://render.com).
3. Connect your GitHub repo — Render will auto-detect the `render.yaml`.
4. In the Render dashboard, add environment variables for your API keys:
   - `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` (one LLM provider)
   - `ELEVENLABS_API_KEY` or `CARTESIA_API_KEY` (one TTS provider)
   - Optionally: `ELEVENLABS_VOICE_ID` / `CARTESIA_VOICE_ID` for a cloned voice
5. Deploy — your app will be live at `https://<service-name>.onrender.com`.

### Railway

1. Push this repo to GitHub.
2. Create a new project at [railway.app](https://railway.app) and connect your repo.
3. Railway will auto-detect Python and use the `Procfile`.
4. Add environment variables in the Railway dashboard (same keys as above).
5. Deploy — Railway provides a public URL automatically.

### Heroku

1. Install the [Heroku CLI](https://devcenter.heroku.com/articles/heroku-cli).
2. Create a new app:
   ```bash
   heroku create my-innervoice-app
   ```
3. Set environment variables:
   ```bash
   heroku config:set OPENAI_API_KEY=sk-...
   heroku config:set ELEVENLABS_API_KEY=...
   ```
4. Deploy:
   ```bash
   git push heroku main
   ```

### Fly.io

1. Install the [Fly CLI](https://fly.io/docs/hands-on/install-flyctl/).
2. Launch a new app:
   ```bash
   fly launch
   ```
3. Set secrets:
   ```bash
   fly secrets set OPENAI_API_KEY=sk-...
   fly secrets set ELEVENLABS_API_KEY=...
   ```
4. Deploy:
   ```bash
   fly deploy
   ```

### Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | One of these | OpenAI API key for GPT-4o-mini |
| `ANTHROPIC_API_KEY` | One of these | Anthropic API key for Claude Haiku |
| `ELEVENLABS_API_KEY` | One of these | ElevenLabs API key for TTS |
| `CARTESIA_API_KEY` | One of these | Cartesia API key for TTS |
| `ELEVENLABS_VOICE_ID` | Optional | Custom voice ID (defaults to built-in voice) |
| `CARTESIA_VOICE_ID` | Optional | Custom voice ID for Cartesia |
| `CORS_ORIGINS` | Optional | Allowed origins (defaults to `*`) |

## Persona steering

The wordmark itself is the control -- drag directly on "Inner_____" (no
separate slider widget) to morph the whisper's *intent*, not just its
wording. It's a vertical carousel of persona names that spins as you drag
and snaps to the nearest one on release; a soft top/bottom mask on the
neighboring names is the only hint that it's draggable. Each position swaps
the LLM system prompt used for the continuation (`backend/personas.py`):

| Carousel position | Persona | Steers toward |
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
- **Multi-user voice profiles**: `backend/voice_profile.py` is a flat JSON
  file scoped to a single user, matching the rest of this prototype. Moving
  beyond a single-user demo just means swapping that module for a real
  per-user store (e.g. keyed by session/account) -- `tts.py` and `llm.py`
  only ever call `get_profile()`, so nothing else needs to change.
- **Cartesia voice cloning**: onboarding currently only supports ElevenLabs
  Instant Voice Clone. Cartesia also offers voice cloning; wiring it in
  would mean adding a Cartesia-flavored `voice_clone.py` path and relaxing
  the `resolved_tts_provider == "elevenlabs"` gate in `main.py`.
