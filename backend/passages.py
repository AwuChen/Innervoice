"""
passages.py
-----------
Fixed set of short passages used by the first-run voice-match test (see
docs/research-roadmap.md and README "Voice match test"). Each passage is
short enough to read in a few seconds, so the read-along test stays quick.
"""

from __future__ import annotations

import random
from dataclasses import dataclass


@dataclass(frozen=True)
class Passage:
    id: str
    text: str


PASSAGES: list[Passage] = [
    Passage(
        id="p1",
        text=(
            "The kettle clicks off just as the rain starts. For a moment "
            "everything is quiet, steam curling up past the window."
        ),
    ),
    Passage(
        id="p2",
        text=(
            "She left the note on the counter, folded once, and walked out "
            "before the coffee finished brewing."
        ),
    ),
    Passage(
        id="p3",
        text=(
            "Somewhere between the third and fourth floor, the elevator "
            "hums a little louder, like it's thinking something over."
        ),
    ),
    Passage(
        id="p4",
        text=(
            "The old dog doesn't bark at the mail carrier anymore, just "
            "lifts his head, sighs, and goes back to sleep."
        ),
    ),
    Passage(
        id="p5",
        text=(
            "By the time the bus arrived, she'd already decided to walk "
            "instead, just to feel the cold air on her face."
        ),
    ),
]

_BY_ID = {p.id: p for p in PASSAGES}


def get_passage(passage_id: str | None = None) -> Passage:
    """Return a specific passage by id, or a random one if no id is given."""
    if passage_id:
        passage = _BY_ID.get(passage_id)
        if passage:
            return passage
    return random.choice(PASSAGES)
