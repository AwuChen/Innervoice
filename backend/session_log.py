"""
session_log.py
---------------
Lightweight, append-only JSONL event logger for InnerVoice's voice-match
test. This intentionally does not talk to any analytics/telemetry service --
it just writes local newline-delimited JSON under `logs/` so the raw data
behind "how often does the cloned voice match on the first try, and which
feedback tags does it take to get there" can be analyzed offline later.

Logging failures are swallowed (logged, not raised) -- this is research
instrumentation, and it must never be able to break the actual product loop.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from pathlib import Path
from typing import Any

logger = logging.getLogger("innervoice.session_log")

_LOG_DIR = Path(__file__).resolve().parent.parent / "logs"
_RUN_ID = uuid.uuid4().hex[:8]
_LOG_PATH = _LOG_DIR / f"session-{time.strftime('%Y%m%d-%H%M%S')}-{_RUN_ID}.jsonl"


def _write(record: dict[str, Any]) -> None:
    record = {"ts": time.time(), **record}
    try:
        _LOG_DIR.mkdir(parents=True, exist_ok=True)
        with _LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        logger.exception("Failed to write session log record (kind=%s)", record.get("kind"))


def log_voice_feedback(
    *,
    passage_id: str,
    matched: bool,
    issues: list[str],
    old_settings: dict[str, float],
    new_settings: dict[str, float],
) -> None:
    """One record per voice-match test attempt -- the raw dataset behind how
    often the cloned voice matches on the first try vs. how many feedback
    rounds/which issue tags it takes to get there."""
    _write(
        {
            "kind": "voice_feedback",
            "passage_id": passage_id,
            "matched": matched,
            "issues": issues,
            "old_settings": old_settings,
            "new_settings": new_settings,
        }
    )
