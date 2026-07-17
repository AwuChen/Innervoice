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

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend.config import get_settings
from backend.llm import extract_context_facts, extract_onboarding_facts, generate_continuation
from backend.passages import get_passage
from backend.personas import DEFAULT_PERSONA_ID, PERSONAS
from backend.session_log import log_context_learned, log_event, log_predict, log_voice_feedback
from backend.tts import stream_speech, synthesize_with_timestamps
from backend.user_context import add_facts as add_context_facts, reset as reset_context
from backend.voice_clone import (
    VoiceCloneError,
    VoiceSample,
    create_instant_voice_clone,
    delete_voice,
    transcribe_speech,
)
from backend.voice_onboarding_content import (
    MAX_SAMPLES,
    MIN_SAMPLES,
    READING_SCRIPT,
    RECOMMENDED_SECONDS,
    prompts_public,
)
from backend.voice_profile import (
    clear_profile,
    get_profile,
    save_profile,
    get_voice_settings,
    apply_feedback as apply_voice_feedback,
)

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
    history: list[str] = Field(
        default_factory=list,
        description="Recent past whispered continuations, oldest first. Only used "
        "when ENABLE_WHISPER_MEMORY is on (see docs/research-roadmap.md #4); "
        "otherwise ignored server-side.",
    )
    is_opening: bool = Field(
        False,
        description="True for the very first prediction of a session, completing the "
        "guided opener shown right after voice calibration (see docs/research-roadmap.md "
        "#11). Gets a roomier word budget and leans harder on the stored context profile.",
    )


class EventRequest(BaseModel):
    event_type: str = Field(..., description="e.g. 'whisper_interrupted', 'whisper_completed', 'self_report'.")
    payload: dict = Field(default_factory=dict, description="Arbitrary event-specific data.")


class VoiceTestSpeakRequest(BaseModel):
    passage_id: str = Field(..., description="Id of the passage to speak, from GET /api/voice-test/passage.")


class VoiceTestFeedbackRequest(BaseModel):
    passage_id: str = Field(..., description="Which passage this feedback is about.")
    matched: bool = Field(..., description="Whether the cloned voice matched the user's inner voice.")
    issues: list[str] = Field(
        default_factory=list,
        description="Feedback tags when matched=false, e.g. 'too_fast', 'pitch_too_high' "
        "(see backend/voice_profile.py's _FEEDBACK_STEPS for the full set).",
    )


@app.get("/api/personas")
async def list_personas() -> list[dict]:
    """Persona metadata for the frontend slider (never includes system prompts)."""
    return [persona.public_dict() for persona in PERSONAS.values()]


@app.get("/api/config")
async def get_config() -> dict:
    """
    Research-knob config the frontend needs at load time (see
    docs/research-roadmap.md #3/#4). Never includes secrets/API keys.
    """
    return {
        "show_caption": settings.show_caption,
        "enable_whisper_memory": settings.enable_whisper_memory,
        "whisper_memory_turns": settings.whisper_memory_turns,
        "enable_echo_reveal": settings.enable_echo_reveal,
        "echo_reveal_wpm": settings.echo_reveal_wpm,
        "voice_test_preroll_ms": settings.voice_test_preroll_ms,
        "pitch_playback_rate": get_voice_settings()["pitch_playback_rate"],
    }


@app.post("/api/event")
async def report_event(request: EventRequest) -> dict:
    """
    Fire-and-forget beacon for frontend-observed events that matter for the
    research knobs but don't need a response -- e.g. whether a whisper was
    interrupted before finishing (roadmap #3's accuracy-proxy signal) or a
    self-report probe answer (roadmap #1's linger-effect probe).
    """
    log_event(event_type=request.event_type, payload=request.payload)
    return {"status": "logged"}


@app.get("/api/voice-test/passage")
async def voice_test_passage(passage_id: Optional[str] = None) -> dict:
    """
    A short passage for the first-run voice-match test (see
    docs/research-roadmap.md): the user reads this silently while the
    cloned voice reads it aloud in sync, to test whether it matches how
    they hear their own inner voice.
    """
    passage = get_passage(passage_id)
    return {"id": passage.id, "text": passage.text}


@app.post("/api/voice-test/speak")
async def voice_test_speak(request: VoiceTestSpeakRequest) -> dict:
    """
    Synthesize the given passage with word-level timing, so the frontend
    can highlight each word in sync with playback (a karaoke-style
    read-along) instead of just playing audio after a pause.
    """
    passage = get_passage(request.passage_id)

    try:
        settings.resolved_tts_provider
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    try:
        result = await synthesize_with_timestamps(passage.text)
    except Exception as exc:
        logger.exception("Voice-test synthesis failed")
        raise HTTPException(status_code=502, detail="TTS synthesis failed") from exc

    tuned = get_voice_settings()
    return {
        "passage_id": passage.id,
        "audio_base64": result["audio_base64"],
        "words": result["words"],
        "voice_settings": tuned,
        "pitch_playback_rate": tuned["pitch_playback_rate"],
    }


@app.post("/api/voice-test/feedback")
async def voice_test_feedback(request: VoiceTestFeedbackRequest) -> dict:
    """
    Record whether the voice-match test matched, and if not, apply the
    given feedback tags as nudges to the persisted ElevenLabs voice
    settings (backend/voice_profile.py) -- these adjustments carry over to
    the live editor whisper too, not just this test.
    """
    old_settings = get_voice_settings()
    if request.matched or not request.issues:
        new_settings = old_settings
    else:
        result = apply_voice_feedback(request.issues)
        new_settings = result["new"]

    log_voice_feedback(
        passage_id=request.passage_id,
        matched=request.matched,
        issues=request.issues,
        old_settings=old_settings,
        new_settings=new_settings,
    )

    return {"settings": new_settings, "pitch_playback_rate": new_settings["pitch_playback_rate"]}


@app.post("/api/context/reset")
async def reset_user_context() -> dict:
    """
    Erase everything InnerVoice has learned about this person so far (see
    docs/research-roadmap.md #11 and backend/user_context.py) -- the
    transparency/erasure counterpart to the fact that this profile grows
    without a per-turn on-screen disclosure.
    """
    return {"facts": reset_context()}


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


async def _extract_and_store_context(user_text: str, whisper_text: str, source: str) -> None:
    """
    Background task (roadmap #11): runs after the whisper response has
    already been sent, so it can never add latency to the actual product
    loop. Pulls 0-2 short facts out of this turn and folds them into the
    persisted profile that future predictions draw on. `source` is just for
    the research log ("opening" for the guided first-turn answer, which is
    unusually rich context vs. an ordinary "extraction" turn).
    """
    facts = await extract_context_facts(user_text, whisper_text)
    if facts:
        add_context_facts(facts)
        log_context_learned(source=source, facts=facts)


# --------------------------------------------------------------------------
# Voice onboarding: speak through prompts in ONE continuous recording ->
# Instant Voice Clone (+ transcribe the same clip to seed user_context).
#
# Separate free-response spoken clips were tried and dropped -- mixing
# takes with different delivery confused clone consistency. One continuous
# take keeps delivery steadier while still capturing personal content
# (roadmap #11).
# --------------------------------------------------------------------------


class VoiceProfileResponse(BaseModel):
    supported: bool = Field(..., description="Whether Instant Voice Clone is available at all.")
    has_voice: bool
    voice_name: Optional[str] = None
    reading_script: str = Field(
        ...,
        description="Legacy fallback string; spoken onboarding shows context_prompts instead.",
    )
    context_prompts: list[dict] = Field(
        default_factory=list,
        description="Spoken prompts the user answers out loud in one continuous take.",
    )
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
        context_prompts=prompts_public(),
        min_samples=MIN_SAMPLES,
        max_samples=MAX_SAMPLES,
        recommended_seconds=RECOMMENDED_SECONDS,
    )


async def _seed_context_from_onboarding_audio(sample: VoiceSample) -> None:
    """
    Background task: transcribe the onboarding recording and fold short
    facts into user_context. Never raises into the request path -- cloning
    already succeeded by the time this runs.
    """
    transcript = await transcribe_speech(sample)
    if not transcript:
        return
    facts = await extract_onboarding_facts(transcript)
    if facts:
        add_context_facts(facts)
        log_context_learned(source="voice_onboarding", facts=facts)
        logger.info("Seeded %d onboarding context fact(s) from transcript", len(facts))


@app.post("/api/voice/clone", response_model=VoiceCloneResponse)
async def voice_clone(
    background_tasks: BackgroundTasks,
    samples: list[UploadFile] = File(..., description="One continuous spoken-prompt recording."),
    voice_name: str = Form("My InnerVoice"),
) -> VoiceCloneResponse:
    """
    Runs ElevenLabs Instant Voice Clone on the uploaded recording and, on
    success, persists the resulting voice_id so the whisper-back pipeline
    switches to it immediately. The same audio is transcribed in the
    background to seed user_context (roadmap #11).
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

    # Same clip that cloned the voice also seeds context -- in the
    # background so the user isn't blocked waiting on STT + extraction.
    background_tasks.add_task(_seed_context_from_onboarding_audio, voice_samples[0])

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
async def predict(request: PredictRequest, background_tasks: BackgroundTasks):
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

    history = request.history if settings.enable_whisper_memory else None
    predicted_text, word_range = await generate_continuation(
        context, request.persona, history=history, is_opening=request.is_opening
    )

    log_predict(
        persona_id=request.persona,
        input_word_count=len(context.split()),
        target_word_range=word_range,
        predicted_word_count=len(predicted_text.split()) if predicted_text else 0,
        predicted_text=predicted_text,
        show_caption=settings.show_caption,
        whisper_memory_enabled=settings.enable_whisper_memory,
    )

    if not predicted_text:
        return Response(status_code=204)

    logger.info("Predicted continuation: %r (target %d-%d words)", predicted_text, *word_range)

    if settings.enable_context_extraction:
        source = "opening" if request.is_opening else "extraction"
        background_tasks.add_task(_extract_and_store_context, context, predicted_text, source)

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
