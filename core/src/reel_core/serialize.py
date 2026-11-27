"""JSON payload the Electron UI stores as-is."""

from __future__ import annotations

from pathlib import Path

from reel_core.demo.parser import DemoData
from reel_core.models import CameraAction, Moment, PlayerStats, Sequence


def kill_to_dict(kill) -> dict:
    return {
        "tick": kill.tick,
        "attackerSteamid": kill.attacker_steamid,
        "attackerName": kill.attacker_name,
        "victimSteamid": kill.victim_steamid,
        "victimName": kill.victim_name,
        "weapon": kill.weapon,
        "headshot": kill.headshot,
        "noscope": kill.noscope,
        "thrusmoke": kill.thrusmoke,
        "flashed": kill.attackerblind,
        "wallbang": kill.penetrated > 0,
    }


def moment_to_dict(moment: Moment, tickrate: float) -> dict:
    payload = {
        "id": f"{moment.steamid}-{moment.round_index}-{moment.first_tick}",
        "steamid": moment.steamid,
        "name": moment.name,
        "side": moment.side,
        "round": moment.round_index + 1,
        "roundIndex": moment.round_index,
        "score": moment.score,
        "labels": moment.labels,
        "kills": [kill_to_dict(k) for k in moment.kills],
        "firstTick": moment.first_tick,
        "lastTick": moment.last_tick,
        "durationSeconds": round((moment.last_tick - moment.first_tick) / tickrate, 2) if tickrate else 0,
        "clutch": None,
    }
    if moment.clutch is not None:
        payload["clutch"] = {
            "opponents": moment.clutch.opponents,
            "won": moment.clutch.won,
            "kills": moment.clutch.kills,
            "startTick": moment.clutch.start_tick,
        }
    return payload


def stats_to_dict(stats: PlayerStats) -> dict:
    return {
        "steamid": stats.steamid,
        "name": stats.name,
        "side": stats.side,
        "kills": stats.kills,
        "deaths": stats.deaths,
        "assists": stats.assists,
        "adr": stats.adr,
        "kd": stats.kd,
        "kast": stats.kast,
        "rating": stats.rating,
        "hsPercent": stats.hs_percent,
        "multi3k": stats.multi_3k,
        "multi4k": stats.multi_4k,
        "aces": stats.aces,
        "clutchAttempts": stats.clutch_attempts,
        "clutchWins": stats.clutch_wins,
    }


def sequence_to_dict(sequence: Sequence, tickrate: float) -> dict:
    return {
        "number": sequence.number,
        "startTick": sequence.start_tick,
        "endTick": sequence.end_tick,
        "label": sequence.label,
        "score": sequence.score,
        "round": sequence.round_index + 1,
        "filename": sequence.filename,
        "durationSeconds": round(sequence.duration_seconds(tickrate), 2),
        "cameras": [{"tick": c.tick, "steamid": c.steamid} for c in sequence.cameras],
        "momentIds": [f"{m.steamid}-{m.round_index}-{m.first_tick}" for m in sequence.moments],
    }


def parse_payload(
    demo: DemoData,
    moments: list[Moment],
    sequences: list[Sequence],
    stats: dict[str, PlayerStats],
    player_steamid: str | None,
) -> dict:
    last = demo.rounds[-1] if demo.rounds else None
    you = stats.get(player_steamid) if player_steamid else None
    rounds_out = []
    for round_ in demo.rounds:
        round_moments = [m for m in moments if m.round_index == round_.index]
        rounds_out.append(
            {
                "number": round_.index + 1,
                "index": round_.index,
                "startTick": round_.start_tick,
                "freezeEndTick": round_.freeze_end_tick,
                "endTick": round_.end_tick,
                "winner": round_.winner,
                "ctScore": round_.ct_score,
                "tScore": round_.t_score,
                "score": round(max((m.score for m in round_moments), default=0.0), 3),
                "labels": sorted({label for m in round_moments for label in m.labels}),
                "moments": [moment_to_dict(m, demo.tickrate) for m in round_moments],
            }
        )
    return {
        "demoPath": str(demo.path),
        "map": demo.map_name,
        "tickrate": demo.tickrate,
        "scoreline": {
            "ct": last.ct_score if last else 0,
            "t": last.t_score if last else 0,
        },
        "playerSteamid": player_steamid,
        "you": stats_to_dict(you) if you else None,
        "players": [stats_to_dict(s) for s in sorted(stats.values(), key=lambda p: p.rating, reverse=True)],
        "rounds": rounds_out,
        "moments": [moment_to_dict(m, demo.tickrate) for m in moments],
        "sequences": [sequence_to_dict(s, demo.tickrate) for s in sequences],
        "highlightCount": len(moments),
        # spec_player slots, so Record can aim the camera without parsing the demo again.
        "slots": {steamid: int(slot) for steamid, slot in demo.slots.items()},
    }


def load_moments_file(path: Path) -> list[dict]:
    import json

    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, list):
        return data
    if "moments" in data:
        return data["moments"]
    if "sequences" in data:
        return data["sequences"]
    raise ValueError(f"No moments/sequences found in {path}")


def library_demo(demo_path: Path, library: dict) -> DemoData | None:
    """A DemoData built from a saved library payload.

    Record only needs the demo path, tickrate, player names, and spec slots.
    Returning None means the payload is from before slots were stored, and the
    caller should parse the demo.
    """
    raw_slots = library.get("slots")
    if not isinstance(raw_slots, dict) or not raw_slots:
        return None
    slots: dict[str, int] = {}
    for key, value in raw_slots.items():
        try:
            slot = int(value)
        except (TypeError, ValueError):
            continue
        steamid = str(key)
        if steamid and slot > 0:
            slots[steamid] = slot
    if not slots:
        return None
    names: dict[str, str] = {}
    players = library.get("players")
    if isinstance(players, list):
        for player in players:
            if isinstance(player, dict) and player.get("steamid"):
                names[str(player["steamid"])] = str(player.get("name") or "")
    try:
        tickrate = float(library.get("tickrate") or 64)
    except (TypeError, ValueError):
        tickrate = 64.0
    if tickrate <= 0:
        tickrate = 64.0
    return DemoData(
        path=demo_path,
        map_name=str(library.get("map") or ""),
        tickrate=tickrate,
        kills=[],
        deaths=[],
        rounds=[],
        player_names=names,
        slots=slots,
    )


def _sequence_from_dict(item: dict) -> Sequence | None:
    cameras = []
    for camera in item.get("cameras") or []:
        if not isinstance(camera, dict):
            continue
        steamid = str(camera.get("steamid") or "")
        try:
            tick = int(camera.get("tick") or 0)
        except (TypeError, ValueError):
            continue
        if steamid and tick > 0:
            cameras.append(CameraAction(tick=tick, steamid=steamid))
    try:
        start = int(item.get("startTick") or 0)
        end = int(item.get("endTick") or 0)
        number = int(item.get("number") or 1)
        score = float(item.get("score") or 0)
        round_index = max(int(item.get("round") or 1) - 1, 0)
    except (TypeError, ValueError):
        return None
    if not cameras or end <= start:
        return None
    return Sequence(
        number=number,
        start_tick=start,
        end_tick=end,
        cameras=cameras,
        label=str(item.get("label") or ""),
        score=score,
        round_index=round_index,
        filename=str(item.get("filename") or ""),
    )


def sequences_from_library(library: dict, selected_ids: set[str]) -> list[Sequence]:
    """Sequences saved with the match, limited to the queued moment ids.

    An empty id set keeps every saved sequence. Ids that match neither a
    moment nor a sequence number are left for the caller to turn into clips
    from their own tick range.
    """
    raw = library.get("sequences")
    if not isinstance(raw, list):
        return []
    sequences: list[Sequence] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        moment_ids = {str(moment_id) for moment_id in item.get("momentIds") or []}
        number = str(item.get("number") or "")
        if selected_ids and not (moment_ids & selected_ids) and number not in selected_ids:
            continue
        sequence = _sequence_from_dict(item)
        if sequence is not None:
            sequences.append(sequence)
    return sequences
