"""
voice_profile.py
-----------------
Persisted, feedback-adjustable ElevenLabs voice settings.

The voice-match test (see docs/research-roadmap.md and README) lets a user
say "too fast" / "pitch too high" / etc. about their cloned voice; this
module is the single source of truth for the resulting tuned settings, so
that both the match test itself *and* the live editor whisper
(`backend/tts.py`) pick up the same adjustments.

Persisted as a small JSON file under `backend/data/` rather than a database,
consistent with this prototype's existing file-based state (see
`backend/session_log.py`). Not thread-safe beyond what a single-process
FastAPI dev server needs -- concurrent writes are rare (one human giving
feedback at a time) and worst case just clobber each other's last write.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger("innervoice.voice_profile")

_DATA_DIR = Path(__file__).resolve().parent / "data"
_PROFILE_PATH = _DATA_DIR / "voice_profile.json"

# Mirrors the values that used to be hardcoded in tts.py's ElevenLabs payload.
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

# (min, max) clamps per field -- keeps feedback nudges inside ranges that
# stay intelligible (see ElevenLabs voice-settings docs for stability/
# similarity/style/speed; pitch_playback_rate is our own client-side knob).
_CLAMPS: dict[str, tuple[float, float]] = {
    "stability": (0.15, 0.85),
    "similarity_boost": (0.4, 1.0),
    "style": (0.0, 0.6),
    "speed": (0.75, 1.25),
    "pitch_playback_rate": (0.85, 1.15),
}

# issue tag -> (field, step). Positive step nudges the field up, negative down.
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


def _read() -> dict[str, float]:
    if not _PROFILE_PATH.exists():
        return dict(DEFAULTS)
    try:
        with _PROFILE_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return {**DEFAULTS, **{k: float(v) for k, v in data.items() if k in DEFAULTS}}
    except Exception:
        logger.exception("Failed to read voice profile, falling back to defaults")
        return dict(DEFAULTS)


def _write(profile: dict[str, float]) -> None:
    try:
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        with _PROFILE_PATH.open("w", encoding="utf-8") as f:
            json.dump(profile, f, indent=2)
    except Exception:
        logger.exception("Failed to persist voice profile")


def get_voice_settings() -> dict[str, float]:
    """Current tuned settings (stability/similarity_boost/style/speed/pitch_playback_rate)."""
    return _read()


def apply_feedback(issues: list[str]) -> dict[str, Any]:
    """
    Nudge the persisted profile based on a list of feedback issue tags
    (see _FEEDBACK_STEPS for valid tags). Unknown tags are ignored rather
    than raising, so a frontend/backend tag-set drift never 500s.

    Returns {"old": {...}, "new": {...}} for logging/response purposes.
    """
    old = _read()
    new = dict(old)
    for issue in issues:
        step = _FEEDBACK_STEPS.get(issue)
        if not step:
            logger.warning("Unknown voice-feedback issue tag: %r", issue)
            continue
        field, delta = step
        new[field] = _clamp(field, new[field] + delta)
    _write(new)
    return {"old": old, "new": new}


def reset() -> dict[str, float]:
    """Restore defaults (useful for research resets / manual retuning)."""
    _write(dict(DEFAULTS))
    return dict(DEFAULTS)
