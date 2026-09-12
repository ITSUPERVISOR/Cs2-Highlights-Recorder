from reel_core.demo.parser import DemoData
from reel_core.steamids import canonicalize_steamid, steamid_aliases


class PlayerNotFound(ValueError):
    pass


def _roster_text(demo: DemoData) -> str:
    names = [name for name in demo.player_names.values() if name]
    if names:
        return ", ".join(sorted(names))
    steamids = [sid for sid in demo.player_names if sid]
    return ", ".join(sorted(steamids)) or "(none)"


def _lookup_steamid(demo: DemoData, query: str) -> str | None:
    aliases = steamid_aliases(query)
    if not aliases:
        return None
    for steamid in demo.player_names:
        if steamid in aliases or steamid_aliases(steamid) & aliases:
            return steamid
    return None


def resolve_player(demo: DemoData, query: str) -> str:
    query = query.strip()
    canonical = canonicalize_steamid(query)
    if canonical:
        found = _lookup_steamid(demo, canonical)
        if found:
            return found
        raise PlayerNotFound(
            f"SteamID {canonical} not found in this demo. Players: {_roster_text(demo)}"
        )

    lowered = query.lower()
    exact = [sid for sid, name in demo.player_names.items() if name.lower() == lowered]
    if len(exact) == 1:
        return exact[0]
    partial = [sid for sid, name in demo.player_names.items() if lowered in name.lower()]
    if len(partial) == 1:
        return partial[0]
    if len(partial) > 1:
        names = ", ".join(sorted(demo.player_names[sid] for sid in partial))
        raise PlayerNotFound(f"'{query}' matches several players: {names}")
    raise PlayerNotFound(f"Player '{query}' not found. Players in demo: {_roster_text(demo)}")


def resolve_pov(demo: DemoData, preferred: str | None, local_steamids: list[str]) -> str | None:
    """Pick the POV player: preferred SteamID, else a local account that is in the demo."""
    preferred_error: PlayerNotFound | None = None
    if preferred:
        try:
            return resolve_player(demo, preferred)
        except PlayerNotFound as exc:
            preferred_error = exc

    seen: list[str] = []
    for steamid in local_steamids:
        try:
            found = resolve_player(demo, steamid)
        except PlayerNotFound:
            continue
        if found not in seen:
            seen.append(found)
    if len(seen) == 1:
        return seen[0]
    if seen:
        return seen[0]
    if preferred_error is not None:
        raise preferred_error
    return None
