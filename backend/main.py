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
from typing import Optional
from urllib.parse import quote

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend.config import get_settings
from backend.llm import generate_continuation
from backend.tts import stream_speech
from backend.voice_clone import VoiceCloneError, VoiceSample, create_instant_voice_clone, delete_voice
from backend.voice_onboarding_content import (
    MAX_SAMPLES,
    MIN_SAMPLES,
    READING_SCRIPT,
    RECOMMENDED_SECONDS,
)
from backend.voice_profile import clear_profile, get_profile, save_profile

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


# --------------------------------------------------------------------------
# Voice onboarding: record -> Instant Voice Clone -> resume main flow.
#
# This is a one-time (or redo-able) setup step, separate from the hot
# /api/predict loop above. The frontend calls GET /api/voice/profile on
# load to decide whether to show the recording UI at all; once cloning
# succeeds, every subsequent /api/predict call whispers back in that voice
# (see backend/tts.py, which checks the persisted profile before falling
# back to the static ELEVENLABS_VOICE_ID).
# --------------------------------------------------------------------------


class VoiceProfileResponse(BaseModel):
    supported: bool = Field(..., description="Whether Instant Voice Clone is available at all.")
    has_voice: bool
    voice_name: Optional[str] = None
    reading_script: str
    min_samples: int
    max_samples: int
    recommended_seconds: int


class VoiceCloneResponse(BaseModel):
    voice_id: str
    voice_name: str


def _voice_clone_supported() -> bool:
    """Instant Voice Clone is an ElevenLabs feature; only offer it when
    ElevenLabs is actually the configured TTS provider (so the cloned voice
    is guaranteed to be usable by the whisper-back pipeline)."""
    try:
        return settings.resolved_tts_provider == "elevenlabs"
    except RuntimeError:
        return False


@app.get("/api/voice/profile", response_model=VoiceProfileResponse)
async def voice_profile() -> VoiceProfileResponse:
    """Tells the frontend whether to show onboarding, and with what copy."""
    profile = await get_profile()
    return VoiceProfileResponse(
        supported=_voice_clone_supported(),
        has_voice=profile.has_voice,
        voice_name=profile.voice_name,
        reading_script=READING_SCRIPT,
        min_samples=MIN_SAMPLES,
        max_samples=MAX_SAMPLES,
        recommended_seconds=RECOMMENDED_SECONDS,
    )


@app.post("/api/voice/clone", response_model=VoiceCloneResponse)
async def voice_clone(
    samples: list[UploadFile] = File(..., description="The recorded script-reading audio clip."),
    voice_name: str = Form("My InnerVoice"),
) -> VoiceCloneResponse:
    """
    Runs ElevenLabs Instant Voice Clone on the uploaded recordings and, on
    success, persists the resulting voice_id so the whisper-back pipeline
    switches to it immediately -- the frontend can then resume the normal
    typing/whispering flow with no further setup.
    """
    if not _voice_clone_supported():
        raise HTTPException(
            status_code=400,
            detail="Instant Voice Clone requires ElevenLabs to be the configured TTS provider.",
        )
    if not samples:
        raise HTTPException(status_code=400, detail="At least one audio recording is required.")
    if len(samples) > MAX_SAMPLES:
        raise HTTPException(
            status_code=400,
            detail=f"Please send at most {MAX_SAMPLES} recording{'s' if MAX_SAMPLES != 1 else ''}.",
        )

    voice_samples: list[VoiceSample] = []
    for index, upload in enumerate(samples):
        data = await upload.read()
        if not data:
            continue
        voice_samples.append(
            VoiceSample(
                filename=upload.filename or f"sample_{index}.webm",
                content_type=upload.content_type or "audio/webm",
                data=data,
            )
        )

    if not voice_samples:
        raise HTTPException(status_code=400, detail="All uploaded recordings were empty.")

    # Best-effort cleanup of any previous clone so we don't accumulate
    # orphaned voices in the ElevenLabs account every time someone re-records.
    previous = await get_profile()

    try:
        voice_id = await create_instant_voice_clone(
            voice_samples,
            name=voice_name,
            description="Cloned via InnerVoice onboarding.",
        )
    except VoiceCloneError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    await save_profile(voice_id=voice_id, voice_name=voice_name)

    if previous.voice_id and previous.voice_id != voice_id:
        await delete_voice(previous.voice_id)

    logger.info("Voice onboarding complete: voice_id=%s name=%r", voice_id, voice_name)
    return VoiceCloneResponse(voice_id=voice_id, voice_name=voice_name)


@app.post("/api/voice/reset")
async def voice_reset() -> dict:
    """Clears the stored clone so onboarding can be re-run from scratch."""
    profile = await get_profile()
    if profile.voice_id:
        await delete_voice(profile.voice_id)
    await clear_profile()
    return {"status": "ok"}


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

    predicted_text = await generate_continuation(context)
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
