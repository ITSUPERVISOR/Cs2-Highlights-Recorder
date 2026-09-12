"""Canonical SteamID64 / account-id helpers.

CS2 demos and loginusers.vdf both use SteamID64. HLAE/CS2 spectator commands
want the 32-bit account id. Pandas/Arrow may also hand back ints or floats.
"""

from __future__ import annotations

import math
from typing import Any

STEAMID64_BASE = 76561197960265728


def canonicalize_steamid(value: Any) -> str:
    """Return a SteamID64 string, or '' if the value is empty/bot/invalid."""
    if value is None:
        return ""
    if hasattr(value, "as_py"):
        value = value.as_py()
    if isinstance(value, bool):
        return ""
    if isinstance(value, float):
        if not math.isfinite(value) or value <= 0:
            return ""
        value = int(round(value))
    if isinstance(value, int):
        number = value
    else:
        text = str(value).strip()
        if not text or text.lower() in {"nan", "none", "0"}:
            return ""
        if text.endswith(".0"):
            text = text[:-2]
        if "e+" in text.lower() or "e-" in text.lower():
            try:
                number = int(round(float(text)))
            except ValueError:
                return ""
        elif text.isdigit():
            number = int(text)
        else:
            return ""
    if number <= 0:
        return ""
    if number < STEAMID64_BASE:
        number += STEAMID64_BASE
    return str(number)


def account_id(steamid: str) -> str:
    """32-bit account id for spec_player_by_accountid."""
    canonical = canonicalize_steamid(steamid)
    if not canonical:
        return ""
    return str(int(canonical) - STEAMID64_BASE)


def steamid_aliases(steamid: str) -> set[str]:
    canonical = canonicalize_steamid(steamid)
    if not canonical:
        digits = "".join(ch for ch in str(steamid) if ch.isdigit())
        return {digits} if digits else set()
    return {canonical, account_id(canonical)}


def pick_login_steamid(users: dict) -> str | None:
    """Most-recent SteamID64 from a loginusers.vdf `users` mapping."""
    ranked: list[tuple[bool, int, str]] = []
    for steamid, info in users.items():
        if not isinstance(info, dict):
            continue
        canonical = canonicalize_steamid(steamid)
        if not canonical:
            continue
        recent = str(info.get("MostRecent", "0")) == "1"
        try:
            timestamp = int(info.get("Timestamp") or 0)
        except (TypeError, ValueError):
            timestamp = 0
        ranked.append((recent, timestamp, canonical))
    if not ranked:
        return None
    ranked.sort(key=lambda item: (item[0], item[1], item[2]))
    return ranked[-1][2]
