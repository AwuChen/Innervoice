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

import json
import logging
import re

from backend.config import get_settings
from backend.personas import (
    DEFAULT_PERSONA_ID,
    ENSEMBLE_CANDIDATE_IDS,
    PERSONAS,
    get_persona,
)
from backend.user_context import fact_count, get_context_summary

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


def _tokens_for_word_range(max_words: int) -> int:
    """Give the model enough tokens to actually use its word budget."""
    return max(40, min(120, max_words * 3 + 8))


def is_grounded(input_word_count: int, history: list[str] | None = None) -> bool:
    """
    True once InnerVoice has enough signal to stop leaving blanks and start
    finishing thoughts.

    Early / stubby fragments stay open even if a persisted profile already
    exists -- we still want to sense what *this* thought is. Grounding kicks
    in when the current paragraph has taken shape, or when we both know a
    little about them and they've written past a stub, or (with whisper
    memory) after a couple of prior turns.
    """
    settings = get_settings()
    # Always leave room on near-empty stubs; blanks are useful here.
    if input_word_count < 12:
        return False
    if input_word_count >= settings.grounded_min_input_words:
        return True
    if fact_count() >= settings.grounded_min_facts:
        return True
    if settings.enable_whisper_memory and history:
        recent = [h for h in history if h and str(h).strip()]
        if len(recent) >= 2:
            return True
    return False


def target_word_range(
    input_word_count: int,
    *,
    is_opening: bool = False,
    is_grounded: bool = False,
) -> tuple[int, int]:
    """
    Adaptive whisper-duration knob (docs/research-roadmap.md #3): instead of
    always targeting a fixed 10-15 words, scale the target with how much the
    user has typed so far, clamped to [min_continuation_words,
    max_continuation_words]. Setting `duration_words_per_input_word` to 0
    reproduces the old fixed-length-at-the-cap behavior.

    `is_opening` (roadmap #11) overrides all of that with a fixed, roomier
    band (`opening_min_words`/`opening_max_words`) -- the very first whisper
    of a session is a reflection on the guided opener, not a short reactive
    continuation, so it gets more room regardless of how few words the
    opener itself contains.

    `is_grounded` raises the floor/cap to the grounded band so mid-session
    whispers can finish a thought instead of staying stubby/open-ended.
    Opening still wins when both would apply.

    Returns an (min_words, max_words) window -- a small band around the
    scaled target, rather than a single number -- so the model still has a
    little room, the same way the original "10 to 15" range did.
    """
    settings = get_settings()
    if is_opening:
        return settings.opening_min_words, settings.opening_max_words

    if is_grounded:
        floor, cap = settings.grounded_min_words, settings.grounded_max_words
    else:
        floor, cap = settings.min_continuation_words, settings.max_continuation_words

    if settings.duration_words_per_input_word <= 0:
        return floor, cap

    target = round(input_word_count * settings.duration_words_per_input_word)
    target = max(floor, min(cap, target))

    band = 2
    min_words = max(floor, target - band)
    if is_grounded:
        # Keep the full grounded ceiling available so the model can actually
        # land the thought, not just nudge one short half-step forward.
        max_words = cap
    else:
        max_words = min(cap, max(min_words, target))
    return min_words, max_words


def _with_user_context(text: str) -> str:
    """
    Fold the slowly-growing per-person context profile (roadmap #11, see
    `backend/user_context.py`) into the prompt as a background note, the
    same way `_with_whisper_memory` folds in past whispers -- except this
    persists across the whole relationship with InnerVoice, not just one
    session's whisper history.
    """
    settings = get_settings()
    if not settings.enable_user_context:
        return text
    summary = get_context_summary()
    if not summary:
        return text
    return f"[What you quietly know about this person so far: {summary}]\n\n{text}"


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


_ENSEMBLE_PICK_PROMPT = """\
You choose which inner-voice persona should chime in next to help this
person most, based only on what they're writing right now (and any
background notes). Reply with ONLY one of these ids, nothing else:
{candidates}

Quick guide:
- voice: intuitive next thought, slight insight
- mentor: clarity, growth, next steps
- friend: warmth, validation
- demon: sharp self-critique (never harmful)
- future_self: lived perspective from later on their timeline
- absent: absent-minded loop -- no new angle, just keep the existing thought circling
"""


async def select_ensemble_persona(context: str) -> str:
    """
    Pick which concrete persona InnerEnsemble should use for this turn.
    Falls back to the default voice on any failure so Ensemble never 500s.
    """
    candidates = ", ".join(ENSEMBLE_CANDIDATE_IDS)
    system = _ENSEMBLE_PICK_PROMPT.format(candidates=candidates)
    settings = get_settings()
    try:
        provider = settings.resolved_llm_provider
    except RuntimeError:
        return DEFAULT_PERSONA_ID

    prompt = _with_user_context(context.strip() or "(empty)")
    try:
        if provider == "openai":
            raw = await _generate_openai(prompt, system, max_tokens=8, temperature=0.2)
        else:
            raw = await _generate_anthropic(prompt, system, max_tokens=8, temperature=0.2)
    except Exception:
        logger.exception("Ensemble persona selection failed")
        return DEFAULT_PERSONA_ID

    choice = re.sub(r"[^a-z_]", "", (raw or "").strip().lower().split()[0] if raw else "")
    if choice in ENSEMBLE_CANDIDATE_IDS:
        return choice
    for candidate in ENSEMBLE_CANDIDATE_IDS:
        if candidate in (raw or "").lower():
            return candidate
    return DEFAULT_PERSONA_ID


async def resolve_active_persona(persona_id: str, context: str) -> str:
    """Map a requested persona id to the one that will actually generate."""
    if persona_id == "ensemble" or get_persona(persona_id).auto_select:
        return await select_ensemble_persona(context)
    if persona_id in PERSONAS:
        return persona_id
    return DEFAULT_PERSONA_ID


async def generate_continuation(
    context: str,
    persona_id: str = DEFAULT_PERSONA_ID,
    history: list[str] | None = None,
    *,
    is_opening: bool = False,
) -> tuple[str, tuple[int, int], str]:
    """Return (continuation_text, (min_words, max_words), active_persona_id).

    `active_persona_id` is usually the requested persona, except for
    InnerEnsemble which auto-picks a concrete candidate. Returns
    ("", word_range, active_id) on failure so callers can still log.

    `history` (recent past whispered continuations, oldest first) is only
    used when ENABLE_WHISPER_MEMORY is on -- see `_with_whisper_memory`.
    `is_opening` (roadmap #11) marks the very first whisper of a session,
    completing the guided opener right after voice calibration -- it gets a
    roomier word budget and an extra system-prompt nudge to actually use
    whatever context is available, rather than reacting generically.

    Once enough signal has accumulated (`is_grounded`), ordinary turns also
    get a roomier budget plus a nudge to *finish* the thought instead of
    leaving another open blank -- see `is_grounded` / grounded word knobs."""
    settings = get_settings()
    provider = settings.resolved_llm_provider
    active_persona_id = await resolve_active_persona(persona_id, context)
    # Word-count target is based on the user's actual input, not the
    # memory-augmented prompt, so past whispers don't skew the target length.
    input_words = len(context.split())
    grounded = (not is_opening) and is_grounded(input_words, history)
    word_range = target_word_range(
        input_words, is_opening=is_opening, is_grounded=grounded
    )
    # Opening / grounded insight nudges don't apply to absent-minded looping.
    use_opening = is_opening and active_persona_id != "absent"
    use_grounded = grounded and active_persona_id != "absent"
    if use_grounded:
        logger.info(
            "Grounded completion mode (%d input words, %d facts) → %d-%d words",
            input_words,
            fact_count(),
            *word_range,
        )
    system_prompt = get_persona(active_persona_id).render_system_prompt(
        *word_range, is_opening=use_opening, is_grounded=use_grounded
    )
    llm_input = _with_whisper_memory(_with_user_context(context), history)
    max_tokens = _tokens_for_word_range(word_range[1])

    try:
        if provider == "openai":
            raw = await _generate_openai(llm_input, system_prompt, max_tokens=max_tokens)
        else:
            raw = await _generate_anthropic(llm_input, system_prompt, max_tokens=max_tokens)
    except Exception:
        logger.exception("LLM completion failed (provider=%s)", provider)
        return "", word_range, active_persona_id

    cleaned = _clamp_words(_strip_boilerplate(raw), word_range[1])
    return cleaned, word_range, active_persona_id


_RAP_SONG_PROMPT = """\
You are InnerRap's songwriting pass. The user has been freewriting; turn
their material into a short original rap song in their voice.

Rules:
- Output ONLY the lyrics (no title preamble like "Sure, here's a song").
- Structure: optional short title line, then 2 verses and a chorus (label
  them Verse 1 / Chorus / Verse 2 / Chorus).
- Keep it under ~180 words. Rhyme and rhythm matter, but meaning first.
- Stay first-person, grounded in what they actually wrote -- invent lightly
  for flow, never invent a whole new life story.
- No self-harm, violence, or hateful content.
"""


async def generate_rap_song(document_text: str) -> str:
    """Assemble a short rap song from the user's accumulated writing."""
    text = (document_text or "").strip()
    if len(text) < 20:
        return ""

    settings = get_settings()
    try:
        provider = settings.resolved_llm_provider
    except RuntimeError:
        return ""

    prompt = _with_user_context(text[:4000])
    try:
        if provider == "openai":
            raw = await _generate_openai(prompt, _RAP_SONG_PROMPT, max_tokens=400, temperature=0.95)
        else:
            raw = await _generate_anthropic(prompt, _RAP_SONG_PROMPT, max_tokens=400, temperature=1.0)
    except Exception:
        logger.exception("Rap song generation failed")
        return ""

    return _strip_boilerplate(raw).strip()


_EXTRACTION_SYSTEM_PROMPT = """\
You are quietly building a private, compact understanding of a person from
short fragments of their inner monologue and the reflective whisper they
were given in response to it. You never talk to them directly.

Given what they just typed and what they just heard, output a JSON array
of 0 to 2 short strings (each under 12 words) capturing any NEW, concrete,
non-obvious fact, feeling, or theme about this specific person -- not a
restatement of generic writing-tool boilerplate. Only include what's
reasonably inferable from the text itself; never invent biographical
details that aren't implied. If there's nothing worth noting, output [].

Output ONLY the JSON array, nothing else -- no preamble, no explanation.
"""

_ONBOARDING_EXTRACTION_PROMPT = """\
You are extracting a compact private profile from a transcript of someone
answering these spoken prompts in one continuous recording:
- Right now, I feel…
- Something that's been on my mind lately is…
- What I'm trying to figure out is…
- Something that really matters to me right now is…

Output a JSON array of 2 to 6 short strings (each under 14 words) capturing
concrete feelings, themes, or concerns from the transcript. Only include
what's reasonably said or clearly implied -- never invent biography. If the
transcript is empty or unusable, output [].

Output ONLY the JSON array, nothing else.
"""


async def extract_context_facts(user_text: str, whisper_text: str) -> list[str]:
    """
    Background-only (roadmap #11): a small, cheap LLM call that tries to
    pull 0-2 short facts about the user out of one turn, so the persisted
    profile (`backend/user_context.py`) keeps growing without ever slowing
    down or being visible in the actual whisper loop. Always returns a list
    (possibly empty) -- failures are logged, never raised, since this must
    never be able to affect the product loop it runs alongside.
    """
    settings = get_settings()
    try:
        provider = settings.resolved_llm_provider
    except RuntimeError:
        return []

    prompt = f"They typed: {user_text!r}\nThey heard in response: {whisper_text!r}"
    try:
        if provider == "openai":
            raw = await _generate_openai(prompt, _EXTRACTION_SYSTEM_PROMPT, max_tokens=80, temperature=0.3)
        else:
            raw = await _generate_anthropic(prompt, _EXTRACTION_SYSTEM_PROMPT, max_tokens=80, temperature=0.3)
    except Exception:
        logger.exception("Context extraction failed (provider=%s)", provider)
        return []

    return _parse_fact_list(raw)


async def extract_onboarding_facts(transcript: str) -> list[str]:
    """
    Pull a compact fact list from the voice-onboarding spoken transcript
    (roadmap #11). Best-effort -- returns [] on failure so cloning is never
    blocked by a transcription/LLM hiccup.
    """
    transcript = (transcript or "").strip()
    if not transcript:
        return []

    settings = get_settings()
    try:
        provider = settings.resolved_llm_provider
    except RuntimeError:
        return []

    prompt = f"Transcript:\n{transcript}"
    try:
        if provider == "openai":
            raw = await _generate_openai(prompt, _ONBOARDING_EXTRACTION_PROMPT, max_tokens=120, temperature=0.3)
        else:
            raw = await _generate_anthropic(prompt, _ONBOARDING_EXTRACTION_PROMPT, max_tokens=120, temperature=0.3)
    except Exception:
        logger.exception("Onboarding fact extraction failed (provider=%s)", provider)
        return []

    return _parse_fact_list(raw, max_facts=6)


def _parse_fact_list(raw: str, *, max_facts: int = 2) -> list[str]:
    """Best-effort JSON-array parse; malformed/non-list output -> []."""
    cleaned = re.sub(r"^```(json)?|```$", "", raw.strip(), flags=re.IGNORECASE).strip()
    try:
        data = json.loads(cleaned)
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    facts = [str(item).strip() for item in data if isinstance(item, str) and str(item).strip()]
    return facts[:max_facts]


async def _generate_openai(
    context: str, system_prompt: str, *, max_tokens: int = 40, temperature: float = 0.9
) -> str:
    from openai import AsyncOpenAI

    settings = get_settings()
    client = AsyncOpenAI(api_key=settings.openai_api_key)

    response = await client.chat.completions.create(
        model=settings.openai_model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": context},
        ],
        max_tokens=max_tokens,
        temperature=temperature,
        presence_penalty=0.3,
    )
    return (response.choices[0].message.content or "").strip()


async def _generate_anthropic(
    context: str, system_prompt: str, *, max_tokens: int = 40, temperature: float = 1.0
) -> str:
    from anthropic import AsyncAnthropic

    settings = get_settings()
    client = AsyncAnthropic(api_key=settings.anthropic_api_key)

    response = await client.messages.create(
        model=settings.anthropic_model,
        max_tokens=max_tokens,
        temperature=temperature,
        system=system_prompt,
        messages=[{"role": "user", "content": context}],
    )
    text_blocks = [block.text for block in response.content if block.type == "text"]
    return "".join(text_blocks).strip()
