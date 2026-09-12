"""Editor-friendly labels (frag-finder style) plus clip filenames."""

from __future__ import annotations

import re

from reel_core.demo.parser import DemoData
from reel_core.models import Moment

FAST_SECONDS = 6.0
SPREAD_SECONDS = 15.0
PISTOL_ROUND_INDEXES = (0, 12)


def labels_for_moment(moment: Moment, demo: DemoData) -> list[str]:
    labels: list[str] = []
    n = moment.kill_count
    if n >= 5:
        labels.append("ACE")
    elif n == 4:
        labels.append("4K")
    elif n == 3:
        labels.append("3K")

    if n >= 3 and demo.tickrate:
        span = (moment.kills[-1].tick - moment.kills[0].tick) / demo.tickrate
        gaps = [
            (moment.kills[i].tick - moment.kills[i - 1].tick) / demo.tickrate
            for i in range(1, n)
        ]
        if span <= FAST_SECONDS:
            labels.append("fast")
        elif any(gap >= SPREAD_SECONDS for gap in gaps):
            labels.append("spread")

    if moment.clutch is not None and moment.clutch.won:
        labels.append(f"1v{moment.clutch.opponents}")
    if any(k.is_awp_noscope for k in moment.kills):
        labels.append("noscope")
    if any(k.thrusmoke for k in moment.kills):
        labels.append("through-smoke")
    if any(k.is_knife for k in moment.kills):
        labels.append("knife")
    if any(k.attackerblind for k in moment.kills):
        labels.append("flashed")
    if moment.round_index in PISTOL_ROUND_INDEXES:
        labels.append("pistol")
    return labels


def apply_labels(moments: list[Moment], demo: DemoData) -> None:
    for moment in moments:
        moment.labels = labels_for_moment(moment, demo)


def _sanitize(part: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9]+", "-", part).strip("-")
    return cleaned or "clip"


def primary_weapon(moment: Moment) -> str:
    if not moment.kills:
        return ""
    counts: dict[str, int] = {}
    for kill in moment.kills:
        counts[kill.weapon] = counts.get(kill.weapon, 0) + 1
    return max(counts, key=counts.get)


def clip_filename(index: int, moment: Moment, map_name: str) -> str:
    map_short = _sanitize(map_name.replace("de_", ""))
    tags = "-".join(_sanitize(label) for label in moment.labels) or f"{moment.kill_count}K"
    weapon = _sanitize(primary_weapon(moment).upper()) if primary_weapon(moment) else ""
    middle = f"{tags}-{weapon}" if weapon else tags
    return f"{index:02d}_{middle}_{map_short}_r{moment.round_index + 1}.mp4"
