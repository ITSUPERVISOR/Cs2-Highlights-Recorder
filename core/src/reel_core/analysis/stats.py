"""Per-player match stats (ADR, KAST, HLTV 2.0 approximation)."""

from __future__ import annotations

from collections import defaultdict

from reel_core.demo.parser import DemoData
from reel_core.models import Clutch, PlayerStats

TRADE_WINDOW_SECONDS = 5.0


def compute_player_stats(demo: DemoData, clutches: list[Clutch] | None = None) -> dict[str, PlayerStats]:
    stats: dict[str, PlayerStats] = {}

    def bucket(steamid: str, side: str = "") -> PlayerStats:
        if steamid not in stats:
            stats[steamid] = PlayerStats(
                steamid=steamid,
                name=demo.player_names.get(steamid, steamid),
                side=side,
            )
        if side and not stats[steamid].side:
            stats[steamid].side = side
        return stats[steamid]

    kills_by_round: dict[int, list] = defaultdict(list)
    for kill in demo.kills:
        kills_by_round[kill.round_index].append(kill)
        attacker = bucket(kill.attacker_steamid, kill.attacker_side)
        attacker.kills += 1
        if kill.headshot:
            attacker.headshots += 1
        if kill.assister_steamid:
            bucket(kill.assister_steamid).assists += 1

    deaths_by_round: dict[int, list] = defaultdict(list)
    for death in demo.deaths:
        deaths_by_round[death.round_index].append(death)
        bucket(death.victim_steamid).deaths += 1

    for steamid, damage in demo.damage_by_player.items():
        bucket(steamid).damage = damage

    round_kills: dict[tuple[str, int], int] = defaultdict(int)
    for kill in demo.kills:
        round_kills[(kill.attacker_steamid, kill.round_index)] += 1
    for (steamid, _), count in round_kills.items():
        player = bucket(steamid)
        if count >= 5:
            player.aces += 1
        elif count == 4:
            player.multi_4k += 1
        elif count == 3:
            player.multi_3k += 1

    trade_ticks = int(TRADE_WINDOW_SECONDS * demo.tickrate)
    for round_ in demo.rounds:
        roster = demo.rosters.get(round_.index) or {}
        round_deaths = deaths_by_round.get(round_.index, [])
        round_frags = kills_by_round.get(round_.index, [])
        dead = {d.victim_steamid for d in round_deaths}

        traded: set[str] = set()
        attacker_of: dict[str, str] = {}
        for kill in round_frags:
            attacker_of.setdefault(kill.victim_steamid, kill.attacker_steamid)
        for death in round_deaths:
            killer = attacker_of.get(death.victim_steamid)
            if not killer:
                continue
            victim_side = roster.get(death.victim_steamid, "")
            for kill in round_frags:
                if (
                    kill.victim_steamid == killer
                    and kill.tick >= death.tick
                    and kill.tick - death.tick <= trade_ticks
                    and roster.get(kill.attacker_steamid, "") == victim_side
                ):
                    traded.add(death.victim_steamid)
                    break

        participants = set(roster) | {
            k.attacker_steamid for k in round_frags
        } | {d.victim_steamid for d in round_deaths}
        for steamid in participants:
            player = bucket(steamid, roster.get(steamid, ""))
            player.rounds += 1
            got_kill = any(k.attacker_steamid == steamid for k in round_frags)
            got_assist = any(k.assister_steamid == steamid for k in round_frags)
            survived = steamid not in dead
            if got_kill or got_assist or survived or steamid in traded:
                player.kast_rounds += 1

    for clutch in clutches or []:
        player = bucket(clutch.steamid, clutch.side)
        player.clutch_attempts += 1
        if clutch.won:
            player.clutch_wins += 1

    return stats
