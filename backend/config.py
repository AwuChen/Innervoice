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
    MAX_CONTINUATION_WORDS  - default: 15
    CORS_ORIGINS            - comma-separated list, default: "*"
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
    max_continuation_words: int = 15
    min_context_chars: int = 6  # don't bother predicting on near-empty input

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
