"""
user_context.py
----------------
Persisted, slowly-growing understanding of the person using InnerVoice: a
small set of short facts/themes, either given directly (the guided opening
prompt right after voice calibration -- see roadmap #11) or quietly
inferred in the background from ordinary turns (`backend/llm.py`'s
`extract_context_facts`, scheduled from `backend/main.py`). Folded into
every `/api/predict` call (see `backend/llm.py`'s `_with_user_context`) so
continuations get more specific/insightful as a session goes on, instead of
every request starting from zero.

Same file-based persistence pattern as `backend/voice_profile.py`: one local
profile, no auth/multi-user support in this prototype.

Because this profile can grow *without* a per-turn "I'm taking notes on
you" disclosure in the live UI, it's deliberately kept to short, low-
sensitivity notes that are reasonably inferable from the person's own words
-- never fabricated biography, never anything about anyone other than the
person typing. It's also fully inspectable/erasable via `reset()` (wired to
`POST /api/context/reset`), which is the transparency/consent trade-off
this file makes explicit -- see docs/research-roadmap.md #11 and the MVPP
discussion under #8/#9 for the broader framing.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger("innervoice.user_context")

_DATA_DIR = Path(__file__).resolve().parent / "data"
_PROFILE_PATH = _DATA_DIR / "user_context.json"

# Capped so the folded-in summary stays short (cheap prompt-wise) and so
# stale early-session facts eventually roll off in favor of more recent ones.
MAX_FACTS = 16


def _read() -> dict[str, Any]:
    if not _PROFILE_PATH.exists():
        return {"facts": []}
    try:
        with _PROFILE_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
        facts = data.get("facts", [])
        return {"facts": [str(f) for f in facts if isinstance(f, str) and str(f).strip()]}
    except Exception:
        logger.exception("Failed to read user context profile, starting fresh")
        return {"facts": []}


def _write(facts: list[str]) -> None:
    try:
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        with _PROFILE_PATH.open("w", encoding="utf-8") as f:
            json.dump({"facts": facts, "updated_at": time.time()}, f, indent=2)
    except Exception:
        logger.exception("Failed to persist user context profile")


def add_facts(new_facts: list[str]) -> list[str]:
    """
    Append new facts (deduplicated, capped to the most recent MAX_FACTS).
    Used both for the direct opening-prompt answer and for background
    extraction results -- callers don't need to know which.
    """
    if not new_facts:
        return _read()["facts"]
    facts = _read()["facts"]
    for fact in new_facts:
        fact = fact.strip()
        if fact and fact not in facts:
            facts.append(fact)
    facts = facts[-MAX_FACTS:]
    _write(facts)
    return facts


def get_facts() -> list[str]:
    """Return the current fact list (most recent last), or []."""
    return _read()["facts"]


def fact_count() -> int:
    """How many short facts are currently on file about this person."""
    return len(_read()["facts"])


def get_context_summary() -> str:
    """Compact ' / '-joined string of everything known so far, or '' if empty."""
    return " / ".join(_read()["facts"])


def reset() -> list[str]:
    """Erase everything InnerVoice has learned about this person so far."""
    _write([])
    return []
