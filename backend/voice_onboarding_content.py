"""
voice_onboarding_content.py
----------------------------
Static copy shown during the one-time voice-setup flow: a phonetically
varied reading passage (for a clean Instant Voice Clone sample) plus a
handful of "get to know you" prompts the user answers out loud in a more
natural, conversational register.

ElevenLabs' own Instant Voice Clone guidance recommends >= 1 minute of
clean audio, and that varied delivery (not just flat reading) produces a
more natural-sounding clone -- hence pairing one scripted passage with a
few free-response prompts rather than asking for one long scripted reading.
"""

from __future__ import annotations

# A short passage engineered to hit a wide range of English phonemes,
# intonation patterns (statements, a question, an exclamation), and pacing
# -- read aloud, this gives Instant Voice Clone a clean, varied sample.
READING_SCRIPT = """\
The quick fox and the lazy dog once shared a quiet afternoon by the river,
watching clouds drift over the hills. "Do you ever wonder," she asked,
"where all this water eventually goes?" He laughed, shrugged, and admitted
he'd never really thought about it before. Some questions are like that --
simple on the surface, but surprisingly deep once you actually sit with
them for a moment."""

# Answered aloud in the user's own words (not read), these add natural,
# unscripted speech to the voice clone and double as a lightweight
# "personality" signal that colors how InnerVoice writes back to them.
PERSONALITY_PROMPTS = [
    "What's something you've been curious about or thinking about lately?",
    "Describe your ideal, completely unproductive Sunday.",
    "If a close friend described your sense of humor in one sentence, what would they say?",
]

MIN_SAMPLES = 1
MAX_SAMPLES = 6
RECOMMENDED_SECONDS = 60
