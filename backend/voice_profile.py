"""
voice_profile.py
-----------------
Tiny persisted "who is this user" record for the single-user prototype:

    - `voice_id`   - the ElevenLabs voice produced by Instant Voice Clone
                      during onboarding. Once set, `tts.py` whispers back in
                      this voice instead of the static `ELEVENLABS_VOICE_ID`
                      fallback.
    - `voice_name` - display name the user gave their clone.

This is deliberately a flat JSON file rather than a database -- InnerVoice
is a single-user prototype (see README "Future work"). Swap this module out
for a real per-user store first when multi-tenancy is needed; nothing else
in the codebase should need to change since callers only see the small API
below.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Optional

from pydantic import BaseModel

_PROFILE_PATH = Path(__file__).resolve().parent / "data" / "voice_profile.json"
_lock = asyncio.Lock()


class VoiceProfile(BaseModel):
    voice_id: Optional[str] = None
    voice_name: Optional[str] = None
    created_at: Optional[float] = None

    @property
    def has_voice(self) -> bool:
        return bool(self.voice_id)


def _read_sync() -> VoiceProfile:
    if not _PROFILE_PATH.exists():
        return VoiceProfile()
    try:
        raw = json.loads(_PROFILE_PATH.read_text("utf-8"))
        return VoiceProfile(**raw)
    except (json.JSONDecodeError, OSError, ValueError):
        return VoiceProfile()


def _write_sync(profile: VoiceProfile) -> None:
    _PROFILE_PATH.parent.mkdir(parents=True, exist_ok=True)
    _PROFILE_PATH.write_text(json.dumps(profile.model_dump(), indent=2), encoding="utf-8")


async def get_profile() -> VoiceProfile:
    async with _lock:
        return await asyncio.to_thread(_read_sync)


async def save_profile(voice_id: str, voice_name: str) -> VoiceProfile:
    profile = VoiceProfile(
        voice_id=voice_id,
        voice_name=voice_name,
        created_at=time.time(),
    )
    async with _lock:
        await asyncio.to_thread(_write_sync, profile)
    return profile


async def clear_profile() -> None:
    async with _lock:
        await asyncio.to_thread(lambda: _PROFILE_PATH.unlink(missing_ok=True))
