"""
config.py
---------
Centralized configuration for InnerVoice.

All secrets and tunable knobs are pulled from environment variables (optionally
loaded from a local `.env` file). Nothing here talks to a network -- it just
resolves *which* providers to use and validates that the right API keys are
present before the server starts serving requests.

Env vars:
    OPENAI_API_KEY          - required if LLM_PROVIDER=openai (or "auto" + present)
    ANTHROPIC_API_KEY       - required if LLM_PROVIDER=anthropic
    ELEVENLABS_API_KEY      - required if TTS_PROVIDER=elevenlabs
    ELEVENLABS_VOICE_ID     - the (ideally cloned) voice used to "whisper back"
    CARTESIA_API_KEY        - required if TTS_PROVIDER=cartesia
    CARTESIA_VOICE_ID       - the (ideally cloned) voice used to "whisper back"

    LLM_PROVIDER            - "openai" | "anthropic" | "auto" (default: auto)
    TTS_PROVIDER            - "elevenlabs" | "cartesia" | "auto" (default: auto)
    OPENAI_MODEL            - default: gpt-4o-mini
    ANTHROPIC_MODEL         - default: claude-haiku-4-5-20251001
    CARTESIA_MODEL          - default: sonic-2
    MIN_CONTINUATION_WORDS       - default: 4  (floor for the whisper length)
    MAX_CONTINUATION_WORDS       - default: 15 (hard cap, never exceeded)
    DURATION_WORDS_PER_INPUT_WORD - default: 0.6 (research knob, see below)
    SHOW_CAPTION            - default: true  (research knob, see below)
    ENABLE_WHISPER_MEMORY   - default: false (research knob, see below)
    ENABLE_ECHO_REVEAL      - default: false (research knob, see below)
    ECHO_REVEAL_WPM         - default: 165   (research knob, see below)
    VOICE_TEST_PREROLL_MS   - default: 600   (voice-match test, see below)
    CORS_ORIGINS            - comma-separated list, default: "*"

    Research knobs (see docs/research-roadmap.md for the questions these
    exist to test):
    - DURATION_WORDS_PER_INPUT_WORD scales the target whisper length with
      how many words the user has typed so far (clamped between
      MIN_CONTINUATION_WORDS and MAX_CONTINUATION_WORDS), instead of the
      old fixed 10-15 word window -- see roadmap #3.
    - SHOW_CAPTION toggles whether the predicted text is ever shown on
      screen at all, to test whether the on-screen caption matters once
      the whisper has been heard -- see roadmap #4.
    - ENABLE_WHISPER_MEMORY toggles whether recent whispers are fed back
      into the LLM as prior context (a growing "innervoice conversation"
      history) instead of each request being stateless -- see roadmap #4.
    - ENABLE_ECHO_REVEAL turns on "Echo Mode": the predicted text reveals
      word-by-word in sync with the whisper's audio (instead of appearing
      instantly), then stays on screen instead of fading, so it can be
      reread -- testing whether closing this loop reinforces the
      innervoice -- see roadmap #10. ECHO_REVEAL_WPM is the assumed
      spoken words-per-minute used only to pace that reveal (not an exact
      timestamp sync -- see roadmap #10 for why).
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal, Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # --- LLM (thought completion) ---
    llm_provider: Literal["openai", "anthropic", "auto"] = "auto"
    openai_api_key: Optional[str] = None
    openai_model: str = "gpt-4o-mini"
    anthropic_api_key: Optional[str] = None
    anthropic_model: str = "claude-haiku-4-5-20251001"

    # --- TTS (whisper-back voice) ---
    tts_provider: Literal["elevenlabs", "cartesia", "auto"] = "auto"

    elevenlabs_api_key: Optional[str] = None
    elevenlabs_voice_id: str = "JBFqnCBsd6RMkjVDRZzb"  # placeholder default voice
    elevenlabs_model: str = "eleven_turbo_v2_5"  # low-latency model

    cartesia_api_key: Optional[str] = None
    cartesia_voice_id: Optional[str] = None
    cartesia_model: str = "sonic-2"

    # --- Behavior tuning ---
    min_continuation_words: int = 4
    max_continuation_words: int = 15
    min_context_chars: int = 6  # don't bother predicting on near-empty input

    # --- Research knobs (see docs/research-roadmap.md) ---
    # Target whisper length scales with input length: target_words ~=
    # round(input_word_count * duration_words_per_input_word), clamped to
    # [min_continuation_words, max_continuation_words]. Set to 0 to always
    # target max_continuation_words (the old fixed-length behavior).
    duration_words_per_input_word: float = 0.6
    show_caption: bool = True
    enable_whisper_memory: bool = False
    whisper_memory_turns: int = 3  # how many past whispers to remember
    enable_echo_reveal: bool = False  # "Echo Mode": synced word-reveal + persistent readback
    echo_reveal_wpm: int = 165  # assumed speaking rate used only to pace the reveal estimate

    # --- Voice-match test (see docs/research-roadmap.md) ---
    # Delay between the user tapping "Begin" on the first-run voice-match
    # test and the synced read-along (audio + word highlight) actually
    # starting -- a short beat to settle before the karaoke-style playback.
    voice_test_preroll_ms: int = 600

    # --- Server ---
    cors_origins: str = "*"

    @property
    def resolved_llm_provider(self) -> str:
        if self.llm_provider != "auto":
            return self.llm_provider
        if self.openai_api_key:
            return "openai"
        if self.anthropic_api_key:
            return "anthropic"
        raise RuntimeError(
            "No LLM provider configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY "
            "in your environment / .env file."
        )

    @property
    def resolved_tts_provider(self) -> str:
        if self.tts_provider != "auto":
            return self.tts_provider
        if self.elevenlabs_api_key:
            return "elevenlabs"
        if self.cartesia_api_key:
            return "cartesia"
        raise RuntimeError(
            "No TTS provider configured. Set ELEVENLABS_API_KEY or CARTESIA_API_KEY "
            "in your environment / .env file."
        )

    @property
    def cors_origin_list(self) -> list[str]:
        if self.cors_origins.strip() == "*":
            return ["*"]
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    """Settings are cheap to build but env parsing only needs to happen once."""
    return Settings()
