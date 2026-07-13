"""
voice_onboarding_content.py
----------------------------
Static copy shown during the one-time voice-setup flow: a single,
phonetically varied reading passage for Instant Voice Clone.

Earlier versions of this flow also asked the user to answer a few
free-response "get to know you" prompts out loud, on the theory that varied,
unscripted delivery makes for a more natural-sounding clone. In practice,
mixing recordings with noticeably different delivery/tone (e.g. one answered
in a deadpan, joking register) confused the clone's accent/tone consistency
more than it helped -- so onboarding now asks for exactly one clean,
consistently-delivered reading instead, which produces the most accurate
clone.
"""

from __future__ import annotations

# A single passage engineered to hit a wide range of English phonemes,
# intonation patterns (statements, a question, some emotional variation),
# and pacing -- read aloud in one consistent, natural voice, this gives
# Instant Voice Clone a clean sample without the tone drift that mixing in
# separate free-response answers can introduce.
READING_SCRIPT = """\
On mornings when the fog hasn't yet lifted from the valley, the old house
creaks awake slowly, as if reluctant to greet the day. Somewhere down the
hall, a kettle begins to whistle, and for a moment, everything holds
perfectly still. Have you ever noticed how the quietest hours often carry
the loudest thoughts? Maybe it's because there's nothing else competing
for your attention. Outside, a delivery truck rumbles past, rattling the
windows just enough to remind you the rest of the world is still turning.
By noon, the fog will be gone, the coffee will be cold, and none of this
will matter quite the same way. But right now, in this in-between hour,
it feels like anything is still possible."""

MIN_SAMPLES = 1
MAX_SAMPLES = 1
RECOMMENDED_SECONDS = 60
