"""
main.py
-------
FastAPI server for InnerVoice.

Single core endpoint, `POST /api/predict`:
    1. Receives the user's current paragraph/context.
    2. Asks a fast LLM to continue the thought in <= ~15 words.
    3. Immediately starts streaming that continuation through TTS.
    4. Streams the resulting MP3 bytes straight back to the client as they
       arrive (no server-side buffering of the full clip), with the
       predicted text echoed in a response header so the frontend can show
       a subtle caption if it wants to.

Also serves the static frontend so the whole prototype can be run with a
single command: `uvicorn backend.main:app --reload`.
"""

from __future__ import annotations

import logging
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend.config import get_settings
from backend.llm import generate_continuation
from backend.personas import DEFAULT_PERSONA_ID, PERSONAS
from backend.tts import stream_speech

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("innervoice.main")

settings = get_settings()

app = FastAPI(title="InnerVoice", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    # The frontend needs to read this custom header off the streaming response.
    expose_headers=["X-Predicted-Text"],
)


class PredictRequest(BaseModel):
    text: str = Field(..., description="The user's current paragraph/context.")
    persona: str = Field(
        DEFAULT_PERSONA_ID,
        description="Which inner-voice persona to steer the continuation with "
        "(see GET /api/personas for the available ids).",
    )


@app.get("/api/personas")
async def list_personas() -> list[dict]:
    """Persona metadata for the frontend slider (never includes system prompts)."""
    return [persona.public_dict() for persona in PERSONAS.values()]


@app.get("/api/health")
async def health() -> dict:
    """Lightweight liveness + config sanity check."""
    try:
        llm_provider = settings.resolved_llm_provider
    except RuntimeError as exc:
        llm_provider = f"UNCONFIGURED ({exc})"
    try:
        tts_provider = settings.resolved_tts_provider
    except RuntimeError as exc:
        tts_provider = f"UNCONFIGURED ({exc})"

    return {"status": "ok", "llm_provider": llm_provider, "tts_provider": tts_provider}


@app.post("/api/predict")
async def predict(request: PredictRequest):
    """
    Core InnerVoice loop: text context in -> streamed whisper audio out.

    Returns a `204 No Content` (no body) when the context is too short or
    the model declines to produce a usable continuation, so the frontend
    can simply no-op instead of treating it as an error.
    """
    context = request.text.strip()
    if len(context) < settings.min_context_chars:
        return Response(status_code=204)

    # Fail loudly (503) on missing API keys rather than silently returning
    # 204s that would look like "no good prediction" to the frontend.
    try:
        settings.resolved_llm_provider
        settings.resolved_tts_provider
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    predicted_text = await generate_continuation(context, request.persona)
    if not predicted_text:
        return Response(status_code=204)

    logger.info("Predicted continuation: %r", predicted_text)

    async def audio_iterator():
        try:
            async for chunk in stream_speech(predicted_text):
                yield chunk
        except Exception:
            # Client likely already got a partial stream; nothing more we can
            # do but log it. Raising here would just produce a truncated
            # response, which the frontend already handles gracefully.
            logger.exception("TTS streaming failed mid-response")

    headers = {
        # Header values must be latin-1 safe, hence the URL-encoding.
        "X-Predicted-Text": quote(predicted_text),
        "Cache-Control": "no-store",
    }
    return StreamingResponse(audio_iterator(), media_type="audio/mpeg", headers=headers)


# --- Static frontend (mounted last so it never shadows the /api routes) ---
_frontend_dir = Path(__file__).resolve().parent.parent / "frontend"
if _frontend_dir.exists():
    app.mount("/", StaticFiles(directory=str(_frontend_dir), html=True), name="frontend")
else:
    logger.warning("Frontend directory not found at %s; static serving disabled.", _frontend_dir)
