"""
voice_onboarding_content.py
----------------------------
Copy for the one-time voice-setup flow.

The user answers a few short prompts **out loud in one continuous
recording**, then that single clip is used for Instant Voice Clone.
Speaking free-response as *separate* clips was tried earlier and dropped:
mixing takes with different delivery/tone (deadpan vs joking, etc.)
confused the clone's accent/tone consistency more than it helped. One
continuous take through the prompts keeps delivery steadier while still
giving us personal content to seed `user_context` (via transcription after
clone -- see `backend/voice_clone.py` / `backend/main.py`).
"""

from __future__ import annotations


# Shown on-screen as a speaking guide while the user records one continuous
# take. Order matters: they work through them top to bottom in the same
# honest, conversational register.
CONTEXT_PROMPTS: list[dict[str, str]] = [
    {
        "id": "feeling",
        "label": "Right now, I feel…",
        "hint": "Say a sentence or two out loud.",
    },
    {
        "id": "on_my_mind",
        "label": "Something that's been on my mind lately is…",
        "hint": "Keep going in the same voice -- don't restart.",
    },
    {
        "id": "working_through",
        "label": "What I'm trying to figure out is…",
        "hint": "Stay natural; pauses are fine.",
    },
    {
        "id": "matters",
        "label": "Something that really matters to me right now is…",
        "hint": "Finish here, then stop the recording.",
    },
]

MIN_SAMPLES = 1
MAX_SAMPLES = 1
RECOMMENDED_SECONDS = 60


def prompts_public() -> list[dict[str, str]]:
    """Prompt metadata safe to send to the frontend."""
    return [
        {"id": p["id"], "label": p["label"], "hint": p["hint"]}
        for p in CONTEXT_PROMPTS
    ]


# Kept as a soft fallback label in older clients; spoken flow no longer
# displays a fixed reading script.
READING_SCRIPT = (
    "Right now I feel… Something that's been on my mind lately is… "
    "What I'm trying to figure out is… Something that really matters "
    "to me right now is…"
)
