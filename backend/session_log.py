"""
session_log.py
---------------
Lightweight, append-only JSONL event logger for InnerVoice's research
knobs (see docs/research-roadmap.md). This intentionally does not talk to
any analytics/telemetry service -- it just writes local newline-delimited
JSON under `logs/` so the raw data behind the duration (#3) and
utility/screen (#4) research questions can be analyzed offline later.

Two kinds of events are logged:
    - "predict": one per `/api/predict` call, capturing the adaptive
      word-count target vs. what was actually produced (roadmap #3).
    - "event": frontend-reported beacons, e.g. whether a whisper was
      interrupted before it finished playing, or a self-report probe
      (roadmap #1) -- anything posted to `POST /api/event`.

Logging failures are swallowed (logged, not raised) -- this is research
instrumentation, and it must never be able to break the actual product
loop of "type -> hear a whisper."
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


def log_predict(
    *,
    persona_id: str,
    input_word_count: int,
    target_word_range: tuple[int, int],
    predicted_word_count: int,
    predicted_text: str,
    show_caption: bool,
    whisper_memory_enabled: bool,
) -> None:
    """One record per `/api/predict` call -- the raw duration-research dataset."""
    _write(
        {
            "kind": "predict",
            "persona_id": persona_id,
            "input_word_count": input_word_count,
            "target_min_words": target_word_range[0],
            "target_max_words": target_word_range[1],
            "predicted_word_count": predicted_word_count,
            "predicted_text": predicted_text,
            "show_caption": show_caption,
            "whisper_memory_enabled": whisper_memory_enabled,
        }
    )


def log_event(*, event_type: str, payload: dict[str, Any]) -> None:
    """One record per frontend-reported beacon (interruption, self-report probe, etc.)."""
    _write({"kind": "event", "event_type": event_type, **payload})


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
