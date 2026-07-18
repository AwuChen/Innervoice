"""
tts.py
------
Streams synthesized speech bytes for a short phrase, as they are generated,
using either ElevenLabs or Cartesia. Both providers are normalized to emit
MP3 bytes (`audio/mpeg`) so the frontend's playback engine can stay identical
regardless of which provider is configured.

Both streaming implementations use `httpx.AsyncClient` in streaming mode and
`yield` chunks directly from the upstream HTTP response -- there is no
buffering of the full audio file server-side, which is what keeps
time-to-first-byte low.

`voice_settings` (stability/similarity_boost/style/speed) are no longer
hardcoded here -- they're read from `backend.voice_profile` on every call, so
feedback from the voice-match test (docs/research-roadmap.md) tunes both the
match test itself and this live "whisper back" loop.
"""

from __future__ import annotations

import base64
import logging
from typing import Any, AsyncGenerator

import httpx

from backend.config import get_settings
from backend.voice_profile import get_profile, get_voice_settings

logger = logging.getLogger("innervoice.tts")

# Generous but bounded timeouts: connect fast, allow some time for streaming.
_TIMEOUT = httpx.Timeout(connect=5.0, read=20.0, write=10.0, pool=5.0)
# with-timestamps calls return the full clip in one response rather than
# streaming, so give them a bit more headroom than the streaming timeout.
_TIMESTAMPS_TIMEOUT = httpx.Timeout(connect=5.0, read=30.0, write=10.0, pool=5.0)


def _elevenlabs_voice_settings_payload() -> dict[str, Any]:
    tuned = get_voice_settings()
    return {
        "stability": tuned["stability"],
        "similarity_boost": tuned["similarity_boost"],
        "style": tuned["style"],
        "speed": tuned["speed"],
        "use_speaker_boost": True,
    }


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
    # Prefer the voice the user cloned for themselves during onboarding
    # (Instant Voice Clone); fall back to the static env-configured voice
    # if they haven't gone through that flow (or skipped it).
    profile = await get_profile()
    voice_id = profile.voice_id or settings.elevenlabs_voice_id
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream"

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
        "voice_settings": _elevenlabs_voice_settings_payload(),
    }

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        async with client.stream("POST", url, headers=headers, params=params, json=payload) as response:
            if response.status_code >= 400:
                body = await response.aread()
                logger.error("ElevenLabs error %s: %s", response.status_code, body[:500])
                response.raise_for_status()
            async for chunk in response.aiter_bytes():
                yield chunk


async def synthesize_with_timestamps(text: str) -> dict[str, Any]:
    """
    Synthesize `text` and return `{"audio_base64": str, "words": [{"text",
    "start", "end"}]}` for the voice-match test's karaoke-style word
    highlight (see docs/research-roadmap.md).

    ElevenLabs: uses the non-streaming `/with-timestamps` endpoint, which
    returns character-level alignment lined up 1:1 with the input text --
    grouped here into per-word spans by splitting on whitespace.

    Cartesia: has no equivalent alignment endpoint wired up here, so word
    timing is estimated evenly across the synthesized clip's duration (a
    known approximation -- Cartesia is the secondary/fallback provider for
    this feature).
    """
    settings = get_settings()
    provider = settings.resolved_tts_provider
    if provider == "elevenlabs":
        return await _synthesize_elevenlabs_with_timestamps(text)
    return await _synthesize_cartesia_estimated(text)


async def _synthesize_elevenlabs_with_timestamps(text: str) -> dict[str, Any]:
    settings = get_settings()
    # Prefer the user's Instant Voice Clone when present -- same voice the
    # live whisper stream uses (see _stream_elevenlabs).
    profile = await get_profile()
    voice_id = profile.voice_id or settings.elevenlabs_voice_id
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps"

    headers = {
        "xi-api-key": settings.elevenlabs_api_key,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    params = {"output_format": "mp3_44100_128"}
    payload = {
        "text": text,
        "model_id": settings.elevenlabs_model,
        "voice_settings": _elevenlabs_voice_settings_payload(),
    }

    async with httpx.AsyncClient(timeout=_TIMESTAMPS_TIMEOUT) as client:
        response = await client.post(url, headers=headers, params=params, json=payload)
        if response.status_code >= 400:
            logger.error("ElevenLabs with-timestamps error %s: %s", response.status_code, response.text[:500])
            response.raise_for_status()
        data = response.json()

    audio_base64: str = data["audio_base64"]
    alignment = data.get("alignment") or data.get("normalized_alignment")
    words = _words_from_character_alignment(text, alignment) if alignment else _estimate_word_timings(text, None)
    return {"audio_base64": audio_base64, "words": words}


def _words_from_character_alignment(text: str, alignment: dict[str, Any]) -> list[dict[str, Any]]:
    """
    Group ElevenLabs' per-character alignment into per-word [start, end]
    spans by walking `text`'s whitespace-delimited words alongside the
    aligned character list (which lines up 1:1 with `text`).
    """
    chars: list[str] = alignment.get("characters") or []
    starts: list[float] = alignment.get("character_start_times_seconds") or []
    ends: list[float] = alignment.get("character_end_times_seconds") or []

    if not chars or len(chars) != len(text):
        # Alignment didn't line up with our input text 1:1 (e.g. provider
        # normalization) -- fall back to an even estimate rather than
        # producing garbled highlight timing.
        return _estimate_word_timings(text, ends[-1] if ends else None)

    words: list[dict[str, Any]] = []
    char_index = 0
    for word in text.split():
        # Skip whitespace/separator characters between words.
        while char_index < len(chars) and chars[char_index].isspace():
            char_index += 1
        word_start_index = char_index
        consumed = 0
        while char_index < len(chars) and consumed < len(word):
            char_index += 1
            consumed += 1
        word_end_index = char_index - 1
        if word_start_index < len(starts) and word_end_index < len(ends):
            words.append(
                {
                    "text": word,
                    "start": starts[word_start_index],
                    "end": ends[word_end_index],
                }
            )
    return words


def _estimate_word_timings(text: str, total_duration: float | None) -> list[dict[str, Any]]:
    """Even-split fallback: divide (an estimated or known) duration across each word."""
    words = text.split()
    if not words:
        return []
    # ~2.5 words/sec (~150 wpm) is a reasonable spoken-word default when we
    # have no real duration to divide by.
    duration = total_duration if total_duration else len(words) / 2.5
    per_word = duration / len(words)
    return [{"text": w, "start": i * per_word, "end": (i + 1) * per_word} for i, w in enumerate(words)]


async def _synthesize_cartesia_estimated(text: str) -> dict[str, Any]:
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
        "output_format": {"container": "mp3", "sample_rate": 44100, "bit_rate": 128000},
        "language": "en",
    }

    async with httpx.AsyncClient(timeout=_TIMESTAMPS_TIMEOUT) as client:
        response = await client.post(url, headers=headers, json=payload)
        if response.status_code >= 400:
            logger.error("Cartesia error %s: %s", response.status_code, response.text[:500])
            response.raise_for_status()
        audio_bytes = response.content

    audio_base64 = base64.b64encode(audio_bytes).decode("ascii")
    words = _estimate_word_timings(text, None)
    return {"audio_base64": audio_base64, "words": words}


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
