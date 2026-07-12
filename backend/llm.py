"""
llm.py
------
Generates the "next thought" continuation from the user's current
paragraph/context. Optimized for speed, not depth:

- Small, fast models only (gpt-4o-mini / claude-haiku-4-5).
- Tiny max_tokens budget -- we only ever want ~10-15 words back.
- No streaming here: the completion is short enough that a single
  round-trip is already fast (typically a few hundred ms), and streaming
  would only complicate the handoff to TTS for very little latency benefit.
  (See README "Future Work" for how to chain token-streaming straight into
  a WebSocket TTS session for even lower latency.)
"""

from __future__ import annotations

import logging
import re

from backend.config import get_settings

logger = logging.getLogger("innervoice.llm")

SYSTEM_PROMPT = """\
You are InnerVoice: the quiet, intuitive undercurrent of the user's own mind.
You are given the fragment of text the user is currently writing, mid-thought.

Your job: continue their exact sentence or train of thought, in their voice,
as if it were the very next words forming in their head. Be insightful,
specific, and a little surprising -- nudge their idea one honest step
forward rather than restating it.

Rules (follow strictly):
- Output ONLY the continuation text. Never repeat or quote what they already wrote.
- Do not add any preamble, labels, quotation marks, or explanations.
- Write it so it reads as a natural, grammatical continuation of their last words.
- STRICT LENGTH LIMIT: 10 to 15 words maximum. Never exceed 15 words.
- If the input is too short or ambiguous to continue meaningfully, make your
  best gentle guess anyway -- never refuse and never ask a question back.
"""


def _clamp_words(text: str, max_words: int) -> str:
    """Hard safety net in case the model ignores the word-count instruction."""
    text = text.strip().strip('"').strip("'").strip()
    words = text.split()
    if len(words) > max_words:
        text = " ".join(words[:max_words])
    return text


def _strip_boilerplate(text: str) -> str:
    """Remove common LLM preambles like 'Sure, here is...' if they slip through."""
    text = re.sub(r'^(sure|here(\'|’)s.*?:|continuation:)\s*', "", text, flags=re.IGNORECASE)
    return text.strip()


async def generate_continuation(context: str) -> str:
    """Return a short (10-15 word) continuation of `context`, or "" on failure."""
    settings = get_settings()
    provider = settings.resolved_llm_provider

    try:
        if provider == "openai":
            raw = await _generate_openai(context)
        else:
            raw = await _generate_anthropic(context)
    except Exception:
        logger.exception("LLM completion failed (provider=%s)", provider)
        return ""

    cleaned = _clamp_words(_strip_boilerplate(raw), settings.max_continuation_words)
    return cleaned


async def _generate_openai(context: str) -> str:
    from openai import AsyncOpenAI

    settings = get_settings()
    client = AsyncOpenAI(api_key=settings.openai_api_key)

    response = await client.chat.completions.create(
        model=settings.openai_model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": context},
        ],
        max_tokens=40,
        temperature=0.9,
        presence_penalty=0.3,
    )
    return (response.choices[0].message.content or "").strip()


async def _generate_anthropic(context: str) -> str:
    from anthropic import AsyncAnthropic

    settings = get_settings()
    client = AsyncAnthropic(api_key=settings.anthropic_api_key)

    response = await client.messages.create(
        model=settings.anthropic_model,
        max_tokens=40,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": context}],
    )
    text_blocks = [block.text for block in response.content if block.type == "text"]
    return "".join(text_blocks).strip()
