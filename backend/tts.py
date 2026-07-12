"""
tts.py
------
Streams synthesized speech bytes for a short phrase, as they are generated,
using either ElevenLabs or Cartesia. Both providers are normalized to emit
MP3 bytes (`audio/mpeg`) so the frontend's playback engine can stay identical
regardless of which provider is configured.

Both implementations use `httpx.AsyncClient` in streaming mode and `yield`
chunks directly from the upstream HTTP response -- there is no buffering of
the full audio file server-side, which is what keeps time-to-first-byte low.
"""

from __future__ import annotations

import logging
from typing import AsyncGenerator

import httpx

from backend.config import get_settings

logger = logging.getLogger("innervoice.tts")

# Generous but bounded timeouts: connect fast, allow some time for streaming.
_TIMEOUT = httpx.Timeout(connect=5.0, read=20.0, write=10.0, pool=5.0)


async def stream_speech(text: str) -> AsyncGenerator[bytes, None]:
    """Yield MP3 audio chunks for `text` as they arrive from the TTS provider."""
    settings = get_settings()
    provider = settings.resolved_tts_provider

    if provider == "elevenlabs":
        generator = _stream_elevenlabs(text)
    else:
        generator = _stream_cartesia(text)

    async for chunk in generator:
        if chunk:
            yield chunk


async def _stream_elevenlabs(text: str) -> AsyncGenerator[bytes, None]:
    settings = get_settings()
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{settings.elevenlabs_voice_id}/stream"

    headers = {
        "xi-api-key": settings.elevenlabs_api_key,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
    }
    params = {
        "output_format": "mp3_44100_128",
        # 4 = max latency optimization (trades a little quality for speed).
        "optimize_streaming_latency": "4",
    }
    payload = {
        "text": text,
        "model_id": settings.elevenlabs_model,
        "voice_settings": {
            "stability": 0.45,
            "similarity_boost": 0.85,
            "style": 0.15,
            "use_speaker_boost": True,
        },
    }

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        async with client.stream("POST", url, headers=headers, params=params, json=payload) as response:
            if response.status_code >= 400:
                body = await response.aread()
                logger.error("ElevenLabs error %s: %s", response.status_code, body[:500])
                response.raise_for_status()
            async for chunk in response.aiter_bytes():
                yield chunk


async def _stream_cartesia(text: str) -> AsyncGenerator[bytes, None]:
    settings = get_settings()
    if not settings.cartesia_voice_id:
        raise RuntimeError("CARTESIA_VOICE_ID must be set to use the Cartesia TTS provider.")

    url = "https://api.cartesia.ai/tts/bytes"
    headers = {
        "X-API-Key": settings.cartesia_api_key,
        "Cartesia-Version": "2024-11-13",
        "Content-Type": "application/json",
    }
    payload = {
        "model_id": settings.cartesia_model,
        "transcript": text,
        "voice": {"mode": "id", "id": settings.cartesia_voice_id},
        # mp3 container so the frontend can treat every provider identically.
        "output_format": {"container": "mp3", "sample_rate": 44100, "bit_rate": 128000},
        "language": "en",
    }

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        async with client.stream("POST", url, headers=headers, json=payload) as response:
            if response.status_code >= 400:
                body = await response.aread()
                logger.error("Cartesia error %s: %s", response.status_code, body[:500])
                response.raise_for_status()
            async for chunk in response.aiter_bytes():
                yield chunk
