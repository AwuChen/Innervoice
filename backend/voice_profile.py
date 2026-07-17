"""
voice_profile.py
-----------------
Persisted user voice state for the single-user prototype:

1. Voice Clone Profile (voice_id, voice_name):
   - The ElevenLabs voice produced by Instant Voice Clone during onboarding.
   - Once set, `tts.py` whispers back in this voice instead of the static
     `ELEVENLABS_VOICE_ID` fallback.

2. Voice Settings (stability, similarity_boost, style, speed, pitch_playback_rate):
   - Feedback-adjustable ElevenLabs voice settings.
   - The voice-match test lets a user say "too fast" / "pitch too high" / etc.
   - These tuned settings apply to both the match test and live whisper.

Persisted as small JSON files under `backend/data/` rather than a database,
consistent with this prototype's single-user design. Swap this module out for
a real per-user store when multi-tenancy is needed.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any, Optional

from pydantic import BaseModel

logger = logging.getLogger("innervoice.voice_profile")

_DATA_DIR = Path(__file__).resolve().parent / "data"
_PROFILE_PATH = _DATA_DIR / "voice_profile.json"
_SETTINGS_PATH = _DATA_DIR / "voice_settings.json"
_lock = asyncio.Lock()


# ---------------------------------------------------------------------------
# Voice Clone Profile (identity: which cloned voice to use)
# ---------------------------------------------------------------------------

class VoiceProfile(BaseModel):
    voice_id: Optional[str] = None
    voice_name: Optional[str] = None
    created_at: Optional[float] = None

    @property
    def has_voice(self) -> bool:
        return bool(self.voice_id)


def _read_profile_sync() -> VoiceProfile:
    if not _PROFILE_PATH.exists():
        return VoiceProfile()
    try:
        raw = json.loads(_PROFILE_PATH.read_text("utf-8"))
        return VoiceProfile(**raw)
    except (json.JSONDecodeError, OSError, ValueError):
        return VoiceProfile()


def _write_profile_sync(profile: VoiceProfile) -> None:
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    _PROFILE_PATH.write_text(json.dumps(profile.model_dump(), indent=2), encoding="utf-8")


async def get_profile() -> VoiceProfile:
    async with _lock:
        return await asyncio.to_thread(_read_profile_sync)


async def save_profile(voice_id: str, voice_name: str) -> VoiceProfile:
    profile = VoiceProfile(
        voice_id=voice_id,
        voice_name=voice_name,
        created_at=time.time(),
    )
    async with _lock:
        await asyncio.to_thread(_write_profile_sync, profile)
    return profile


async def clear_profile() -> None:
    async with _lock:
        await asyncio.to_thread(lambda: _PROFILE_PATH.unlink(missing_ok=True))


# ---------------------------------------------------------------------------
# Voice Settings (tuning: how the voice sounds)
# ---------------------------------------------------------------------------

# stability starts on the higher/more-consistent end of its clamp range
# (rather than ElevenLabs' more expressive default) so sentence-to-sentence
# delivery doesn't vary as noticeably -- "too_robotic" feedback can still
# pull it back down if it starts sounding flat.
DEFAULTS: dict[str, float] = {
    "stability": 0.65,
    "similarity_boost": 0.85,
    "style": 0.15,
    "speed": 1.0,
    "pitch_playback_rate": 1.0,
}

_CLAMPS: dict[str, tuple[float, float]] = {
    "stability": (0.15, 0.85),
    "similarity_boost": (0.4, 1.0),
    "style": (0.0, 0.6),
    "speed": (0.75, 1.25),
    "pitch_playback_rate": (0.85, 1.15),
}

_FEEDBACK_STEPS: dict[str, tuple[str, float]] = {
    "too_fast": ("speed", -0.08),
    "too_slow": ("speed", 0.08),
    "pitch_too_high": ("pitch_playback_rate", -0.03),
    "pitch_too_low": ("pitch_playback_rate", 0.03),
    "too_robotic": ("stability", -0.1),
    "too_erratic": ("stability", 0.1),
    "not_like_me": ("similarity_boost", 0.1),
    "too_exaggerated": ("style", -0.1),
}


def _clamp(field: str, value: float) -> float:
    lo, hi = _CLAMPS[field]
    return max(lo, min(hi, value))


def _read_settings() -> dict[str, float]:
    if not _SETTINGS_PATH.exists():
        return dict(DEFAULTS)
    try:
        with _SETTINGS_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return {**DEFAULTS, **{k: float(v) for k, v in data.items() if k in DEFAULTS}}
    except Exception:
        logger.exception("Failed to read voice settings, falling back to defaults")
        return dict(DEFAULTS)


def _write_settings(settings: dict[str, float]) -> None:
    try:
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        with _SETTINGS_PATH.open("w", encoding="utf-8") as f:
            json.dump(settings, f, indent=2)
    except Exception:
        logger.exception("Failed to persist voice settings")


def get_voice_settings() -> dict[str, float]:
    """Current tuned settings (stability/similarity_boost/style/speed/pitch_playback_rate)."""
    return _read_settings()


def apply_feedback(issues: list[str]) -> dict[str, Any]:
    """
    Nudge the persisted settings based on a list of feedback issue tags
    (see _FEEDBACK_STEPS for valid tags). Unknown tags are ignored rather
    than raising, so a frontend/backend tag-set drift never 500s.

    Returns {"old": {...}, "new": {...}} for logging/response purposes.
    """
    old = _read_settings()
    new = dict(old)
    for issue in issues:
        step = _FEEDBACK_STEPS.get(issue)
        if not step:
            logger.warning("Unknown voice-feedback issue tag: %r", issue)
            continue
        field, delta = step
        new[field] = _clamp(field, new[field] + delta)
    _write_settings(new)
    return {"old": old, "new": new}


def reset() -> dict[str, float]:
    """Restore defaults (useful for research resets / manual retuning)."""
    _write_settings(dict(DEFAULTS))
    return dict(DEFAULTS)
