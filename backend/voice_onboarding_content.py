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

The script itself was later lengthened (see git history for the shorter,
~30-45s version): ElevenLabs' own Instant Voice Clone guidance treats
~1 minute as a *minimum*, not a target, and clone quality/consistency
noticeably improves with more clean audio, up to a few minutes. Combined
with disabling the browser's call-oriented audio processing (see
`frontend/onboarding.js`) and running the recording through ElevenLabs'
Audio Isolation before cloning (see `backend/voice_clone.py`), a longer,
cleaner single take gives Instant Voice Clone meaningfully more, and
higher-fidelity, signal to work with.
"""

from __future__ import annotations

# A passage engineered to hit a wide range of English phonemes, intonation
# patterns (statements, questions, some emotional variation), and pacing,
# while running long enough (~90-120s at a natural reading pace) to give
# Instant Voice Clone more than the bare minimum of clean audio. Read aloud
# in one consistent, natural voice -- no need to act, just read normally.
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
it feels like anything is still possible. There's a particular kind of
freedom in the hours nobody else is awake for -- no messages to answer, no
one expecting anything of you yet, just the quiet hum of the refrigerator
and your own thoughts stretching out like they finally have room to move.

Somewhere across town, someone else is probably having this exact same
thought, standing in their own kitchen, watching their own kettle, and
neither of you will ever know it. Isn't that a strange, small kind of
company? By the time the fog lifts and the street starts to wake up, this
whole quiet little world will have folded itself away, waiting patiently
for tomorrow's version of the same hour to come find you again."""

MIN_SAMPLES = 1
MAX_SAMPLES = 1
RECOMMENDED_SECONDS = 90
