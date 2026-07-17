"""
voice_clone.py
--------------
Wraps ElevenLabs' Instant Voice Clone API (`POST /v1/voices/add`): given one
or more short audio recordings of a person speaking, it returns a new
`voice_id` that can immediately be used with `/v1/text-to-speech/{voice_id}`
-- exactly the same endpoint `backend/tts.py` already streams from.

This is intentionally the *only* place that knows about the cloning HTTP
call, so `backend/main.py` just deals with bytes-in / voice_id-out.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx

from backend.config import get_settings

logger = logging.getLogger("innervoice.voice_clone")

# Cloning reads/encodes a minute or two of audio server-side, so give it a
# lot more headroom than the low-latency streaming TTS calls get.
_TIMEOUT = httpx.Timeout(connect=10.0, read=90.0, write=60.0, pool=10.0)

_ADD_VOICE_URL = "https://api.elevenlabs.io/v1/voices/add"
_DELETE_VOICE_URL = "https://api.elevenlabs.io/v1/voices/{voice_id}"
_AUDIO_ISOLATION_URL = "https://api.elevenlabs.io/v1/audio-isolation"


@dataclass
class VoiceSample:
    filename: str
    content_type: str
    data: bytes


class VoiceCloneError(RuntimeError):
    """Raised when ElevenLabs rejects or fails an Instant Voice Clone request."""


async def _isolate_audio(sample: VoiceSample) -> VoiceSample:
    """
    Run a recording through ElevenLabs' Audio Isolation model to strip room
    noise, hum, and other background interference before it ever reaches
    Instant Voice Clone -- background noise picked up by a laptop/phone mic
    is one of the biggest, most common causes of an inaccurate-sounding
    clone, and this fixes it without asking the user to have a treated
    recording booth.

    Best-effort: on any failure (short clip, transient API error, etc.) this
    just returns the original sample untouched so cloning can still proceed.
    """
    settings = get_settings()
    headers = {"xi-api-key": settings.elevenlabs_api_key}
    files = {"audio": (sample.filename, sample.data, sample.content_type or "application/octet-stream")}

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            response = await client.post(_AUDIO_ISOLATION_URL, headers=headers, files=files)
        if response.status_code >= 400:
            logger.warning(
                "Audio isolation failed (%s), using the original recording: %s",
                response.status_code,
                response.text[:300],
            )
            return sample
        # Isolation always hands back clean audio as MP3 regardless of the
        # input container, so make sure the filename/content-type we send on
        # to Instant Voice Clone actually match the bytes we're sending.
        stem = sample.filename.rsplit(".", 1)[0]
        return VoiceSample(filename=f"{stem}_isolated.mp3", content_type="audio/mpeg", data=response.content)
    except Exception:
        logger.exception("Audio isolation request failed, using the original recording")
        return sample


async def create_instant_voice_clone(
    samples: list[VoiceSample],
    name: str,
    description: str = "",
    isolate_background_noise: bool = True,
) -> str:
    """
    Upload `samples` (raw audio bytes, e.g. from MediaRecorder in the
    browser) to ElevenLabs Instant Voice Clone and return the new voice_id.

    Raises `VoiceCloneError` on any failure (missing key, no audio, upstream
    rejection) with a message that's safe to surface to the frontend.
    """
    settings = get_settings()
    if not settings.elevenlabs_api_key:
        raise VoiceCloneError(
            "ELEVENLABS_API_KEY is not configured, so Instant Voice Clone is unavailable."
        )
    if not samples:
        raise VoiceCloneError("No audio samples were provided to clone from.")

    if isolate_background_noise:
        samples = [await _isolate_audio(sample) for sample in samples]

    headers = {"xi-api-key": settings.elevenlabs_api_key}
    data = {"name": name.strip() or "InnerVoice user"}
    if description.strip():
        data["description"] = description.strip()

    files = [
        ("files", (sample.filename, sample.data, sample.content_type or "application/octet-stream"))
        for sample in samples
    ]

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        response = await client.post(_ADD_VOICE_URL, headers=headers, data=data, files=files)

    if response.status_code >= 400:
        detail = _extract_error_detail(response)
        logger.error("ElevenLabs voice clone failed (%s): %s", response.status_code, detail)
        raise VoiceCloneError(f"ElevenLabs rejected the voice clone request: {detail}")

    payload = response.json()
    voice_id = payload.get("voice_id")
    if not voice_id:
        raise VoiceCloneError("ElevenLabs did not return a voice_id.")

    logger.info("Created ElevenLabs voice clone %r (voice_id=%s)", name, voice_id)
    return voice_id


async def delete_voice(voice_id: str) -> None:
    """Best-effort cleanup of a previously cloned voice. Never raises."""
    settings = get_settings()
    if not settings.elevenlabs_api_key or not voice_id:
        return
    headers = {"xi-api-key": settings.elevenlabs_api_key}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.delete(_DELETE_VOICE_URL.format(voice_id=voice_id), headers=headers)
            if resp.status_code >= 400:
                logger.warning("Failed to delete old voice %s: %s", voice_id, resp.text[:300])
    except Exception:
        logger.exception("Failed to delete old voice %s", voice_id)


def _extract_error_detail(response: httpx.Response) -> str:
    try:
        body = response.json()
        detail = body.get("detail")
        if isinstance(detail, dict):
            return detail.get("message") or str(detail)
        if detail:
            return str(detail)
        return str(body)[:300]
    except Exception:
        return response.text[:300]
