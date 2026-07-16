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


def target_word_range(input_word_count: int) -> tuple[int, int]:
    """
    Adaptive whisper-duration knob (docs/research-roadmap.md #3): instead of
    always targeting a fixed 10-15 words, scale the target with how much the
    user has typed so far, clamped to [min_continuation_words,
    max_continuation_words]. Setting `duration_words_per_input_word` to 0
    reproduces the old fixed-length-at-the-cap behavior.

    Returns an (min_words, max_words) window -- a small band around the
    scaled target, rather than a single number -- so the model still has a
    little room, the same way the original "10 to 15" range did.
    """
    settings = get_settings()
    floor, cap = settings.min_continuation_words, settings.max_continuation_words

    if settings.duration_words_per_input_word <= 0:
        return floor, cap

    target = round(input_word_count * settings.duration_words_per_input_word)
    target = max(floor, min(cap, target))

    band = 2
    min_words = max(floor, target - band)
    max_words = min(cap, max(min_words, target))
    return min_words, max_words


def _with_whisper_memory(context: str, history: list[str] | None) -> str:
    """
    Fold recent past whispers into the prompt as a "don't repeat this"
    note, growing the effective context window with the InnerVoice
    conversation itself rather than just the user's raw text (roadmap #4).
    Kept as a plain text prefix (not fake multi-turn messages) since we
    only have the past *outputs*, not the exact user text at each point.
    """
    settings = get_settings()
    if not settings.enable_whisper_memory or not history:
        return context

    recent = [h for h in history[-settings.whisper_memory_turns :] if h]
    if not recent:
        return context

    memory_note = " / ".join(recent)
    return f"[Already whispered earlier in this session, do not repeat: {memory_note}]\n\n{context}"


async def generate_continuation(
    context: str,
    persona_id: str = DEFAULT_PERSONA_ID,
    history: list[str] | None = None,
) -> tuple[str, tuple[int, int]]:
    """Return a (continuation_text, (min_words, max_words)) pair, where the
    continuation is a short, length-adaptive completion of `context`,
    steered by the given persona's system prompt. Returns ("", word_range)
    on failure so callers can still log the target range that was tried.

    `history` (recent past whispered continuations, oldest first) is only
    used when ENABLE_WHISPER_MEMORY is on -- see `_with_whisper_memory`."""
    settings = get_settings()
    provider = settings.resolved_llm_provider
    # Word-count target is based on the user's actual input, not the
    # memory-augmented prompt, so past whispers don't skew the target length.
    word_range = target_word_range(len(context.split()))
    system_prompt = get_persona(persona_id).render_system_prompt(*word_range)
    llm_input = _with_whisper_memory(context, history)

    try:
        if provider == "openai":
            raw = await _generate_openai(llm_input, system_prompt)
        else:
            raw = await _generate_anthropic(llm_input, system_prompt)
    except Exception:
        logger.exception("LLM completion failed (provider=%s)", provider)
        return "", word_range

    cleaned = _clamp_words(_strip_boilerplate(raw), word_range[1])
    return cleaned, word_range


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
