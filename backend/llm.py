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

The system prompt used for the completion is persona-dependent -- see
`backend/personas.py` for the persona registry and prompt text.
"""

from __future__ import annotations

import logging
import re

from backend.config import get_settings
from backend.personas import DEFAULT_PERSONA_ID, get_persona

logger = logging.getLogger("innervoice.llm")


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


async def generate_continuation(context: str, persona_id: str = DEFAULT_PERSONA_ID) -> str:
    """Return a short (10-15 word) continuation of `context`, steered by the
    given persona's system prompt, or "" on failure."""
    settings = get_settings()
    provider = settings.resolved_llm_provider
    system_prompt = get_persona(persona_id).system_prompt

    try:
        if provider == "openai":
            raw = await _generate_openai(context, system_prompt)
        else:
            raw = await _generate_anthropic(context, system_prompt)
    except Exception:
        logger.exception("LLM completion failed (provider=%s)", provider)
        return ""

    cleaned = _clamp_words(_strip_boilerplate(raw), settings.max_continuation_words)
    return cleaned


async def _generate_openai(context: str, system_prompt: str) -> str:
    from openai import AsyncOpenAI

    settings = get_settings()
    client = AsyncOpenAI(api_key=settings.openai_api_key)

    response = await client.chat.completions.create(
        model=settings.openai_model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": context},
        ],
        max_tokens=40,
        temperature=0.9,
        presence_penalty=0.3,
    )
    return (response.choices[0].message.content or "").strip()


async def _generate_anthropic(context: str, system_prompt: str) -> str:
    from anthropic import AsyncAnthropic

    settings = get_settings()
    client = AsyncAnthropic(api_key=settings.anthropic_api_key)

    response = await client.messages.create(
        model=settings.anthropic_model,
        max_tokens=40,
        system=system_prompt,
        messages=[{"role": "user", "content": context}],
    )
    text_blocks = [block.text for block in response.content if block.type == "text"]
    return "".join(text_blocks).strip()
