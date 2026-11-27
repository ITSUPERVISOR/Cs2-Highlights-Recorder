"""Parse a CS2 demo with demoparser2 into DemoData."""

from __future__ import annotations

import gzip
import math
import shutil
from bisect import bisect_right
from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd
from demoparser2 import DemoParser

from reel_core.models import Kill, Round
from reel_core.steamids import canonicalize_steamid

DEFAULT_TICKRATE = 64.0
_SIDE_BY_TEAM_NUM = {2: "T", 3: "CT"}


@dataclass(frozen=True)
class Death:
    tick: int
    round_index: int
    victim_steamid: str


@dataclass
class DemoData:
    path: Path
    map_name: str
    tickrate: float
    kills: list[Kill]
    deaths: list[Death]
    rounds: list[Round]
    player_names: dict[str, str]
    slots: dict[str, int]
    rosters: dict[int, dict[str, str]] = field(default_factory=dict)
    damage_by_player: dict[str, int] = field(default_factory=dict)
    match_start_tick: int = 0
    last_tick: int = 0

    def round_at(self, index: int) -> Round | None:
        if 0 <= index < len(self.rounds):
            return self.rounds[index]
        return None


def ensure_dem_file(path: Path, work_dir: Path) -> Path:
    name = path.name.lower()
    if name.endswith(".dem.gz") or name.endswith(".gz"):
        target = work_dir / path.stem
        if not target.suffix:
            target = target.with_suffix(".dem")
        if target.suffix.lower() != ".dem":
            target = target.with_suffix(".dem")
        target.parent.mkdir(parents=True, exist_ok=True)
        with gzip.open(path, "rb") as src, open(target, "wb") as dst:
            shutil.copyfileobj(src, dst)
        return target
    if name.endswith(".dem.zst") or name.endswith(".zst"):
        import zstandard

        target = work_dir / path.name.replace(".dem.zst", ".dem").replace(".zst", ".dem")
        if not str(target).endswith(".dem"):
            target = target.with_suffix(".dem")
        target.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "rb") as src, open(target, "wb") as dst:
            zstandard.ZstdDecompressor().copy_stream(src, dst)
        return target
    return path


def _normalize_side(value: object) -> str:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return _SIDE_BY_TEAM_NUM.get(int(value), "")
    text = str(value or "").upper()
    if text.startswith("T") and text != "CT":
        return "T"
    if text == "CT":
        return "CT"
    return ""


def _safe_event(parser: DemoParser, name: str, **kwargs) -> pd.DataFrame:
    try:
        df = parser.parse_event(name, **kwargs)
    except Exception:
        return pd.DataFrame()
    if df is None:
        return pd.DataFrame()
    return df


def _col(row: pd.Series, name: str, default=None):
    value = row.get(name, default)
    if pd.isna(value):
        return default
    return value


def _compute_tickrate(parser: DemoParser, sample_ticks: list[int]) -> float:
    if len(sample_ticks) < 2:
        return DEFAULT_TICKRATE
    t1, t2 = min(sample_ticks), max(sample_ticks)
    if t2 - t1 < 256:
        return DEFAULT_TICKRATE
    try:
        df = parser.parse_ticks(["game_time"], ticks=[t1, t2])
    except Exception:
        return DEFAULT_TICKRATE
    if df.empty:
        return DEFAULT_TICKRATE
    grouped = df.groupby("tick")["game_time"].first()
    if len(grouped) < 2:
        return DEFAULT_TICKRATE
    dt = grouped.index.max() - grouped.index.min()
    dgt = grouped.loc[grouped.index.max()] - grouped.loc[grouped.index.min()]
    if dgt <= 0:
        return DEFAULT_TICKRATE
    rate = dt / dgt
    if not math.isfinite(rate) or rate < 16 or rate > 256:
        return DEFAULT_TICKRATE
    return float(round(rate))


# One pass covers every event the match summary needs. Separate calls rescan the file.
MATCH_EVENTS = (
    "begin_new_match",
    "player_death",
    "round_start",
    "round_end",
    "round_freeze_end",
    "player_hurt",
)


def _match_event_kwargs(name: str) -> dict:
    if name == "player_death":
        return {"player": ["team_name"], "other": ["is_warmup_period"]}
    if name == "player_hurt":
        return {"other": ["is_warmup_period"]}
    return {}


def _load_match_events(parser: DemoParser) -> dict[str, pd.DataFrame]:
    """Read the match events together, or one name at a time if a build cannot."""
    parse_events = getattr(parser, "parse_events", None)
    if parse_events is not None:
        try:
            pairs = parse_events(
                list(MATCH_EVENTS),
                player=["team_name"],
                other=["is_warmup_period"],
            )
        except Exception:
            pairs = None
        loaded: dict[str, pd.DataFrame] = {}
        for item in pairs or []:
            if not isinstance(item, tuple) or len(item) != 2:
                continue
            name, frame = item
            loaded[str(name)] = frame if isinstance(frame, pd.DataFrame) else pd.DataFrame()
        if "player_death" in loaded and "round_end" in loaded:
            return {name: loaded.get(name, pd.DataFrame()) for name in MATCH_EVENTS}
    return {
        name: _safe_event(parser, name, **_match_event_kwargs(name))
        for name in MATCH_EVENTS
    }


def _sample_player_rows(parser: DemoParser, ticks: list[int]) -> pd.DataFrame:
    """Slots, side rosters, and tickrate share one tick read."""
    unique = sorted({int(tick) for tick in ticks if int(tick) >= 0})
    if not unique:
        return pd.DataFrame()
    try:
        df = parser.parse_ticks(
            ["is_alive", "team_num", "user_id", "game_time"],
            ticks=unique,
        )
    except Exception:
        return pd.DataFrame()
    if not isinstance(df, pd.DataFrame):
        return pd.DataFrame()
    return df


def _tickrate_from_rows(df: pd.DataFrame, t1: int, t2: int) -> float | None:
    if df.empty or "game_time" not in df.columns or "tick" not in df.columns:
        return None
    subset = df[df["tick"].isin((t1, t2))]
    if subset.empty:
        return None
    grouped = subset.groupby("tick")["game_time"].first()
    if len(grouped) < 2:
        return None
    dt = grouped.index.max() - grouped.index.min()
    elapsed = grouped.loc[grouped.index.max()] - grouped.loc[grouped.index.min()]
    if elapsed <= 0:
        return None
    rate = dt / float(elapsed)
    if not math.isfinite(rate) or rate < 16 or rate > 256:
        return None
    return float(round(rate))


def _rosters_from_rows(df: pd.DataFrame, rounds: list[Round]) -> dict[int, dict[str, str]] | None:
    if df.empty or "is_alive" not in df.columns or "team_num" not in df.columns or "tick" not in df.columns:
        return None
    sample_by_tick = {r.freeze_end_tick + 16: r.index for r in rounds}
    if not sample_by_tick:
        return {r.index: {} for r in rounds}
    present = {int(tick) for tick in df["tick"].unique()}
    if not present.intersection(sample_by_tick):
        return None
    rosters: dict[int, dict[str, str]] = {r.index: {} for r in rounds}
    for row in df.to_dict("records"):
        tick = int(row["tick"])
        round_index = sample_by_tick.get(tick)
        if round_index is None:
            continue
        if not bool(row.get("is_alive", False)):
            continue
        side = _normalize_side(row.get("team_num"))
        if side not in ("CT", "T"):
            continue
        steamid = canonicalize_steamid(row.get("steamid", ""))
        if steamid:
            rosters[round_index][steamid] = side
    return rosters


def _slots_from_rows(df: pd.DataFrame, sample_tick: int) -> dict[str, int] | None:
    if df.empty or "user_id" not in df.columns or "tick" not in df.columns:
        return None
    rows = [row for row in df.to_dict("records") if int(row["tick"]) == int(sample_tick)]
    if not rows:
        return None
    slots: dict[str, int] = {}
    for row in rows:
        steamid = canonicalize_steamid(row.get("steamid", ""))
        user_id = row.get("user_id")
        if steamid and pd.notna(user_id):
            slots[steamid] = int(user_id) + 1
    return slots


def _build_rounds(
    starts: pd.DataFrame,
    ends: pd.DataFrame,
    freeze_ends: pd.DataFrame,
    match_start_tick: int,
) -> list[Round]:
    start_ticks = sorted(int(t) for t in starts.get("tick", pd.Series(dtype=int))) if not starts.empty else []
    freeze_ticks = (
        sorted(int(t) for t in freeze_ends.get("tick", pd.Series(dtype=int))) if not freeze_ends.empty else []
    )

    rounds: list[Round] = []
    if ends.empty:
        return rounds
    ends = ends.sort_values("tick")
    ct_score = 0
    t_score = 0
    for row in ends.to_dict("records"):
        end_tick = int(row["tick"])
        if end_tick < match_start_tick:
            continue
        prior_starts = [t for t in start_ticks if t <= end_tick]
        start_tick = prior_starts[-1] if prior_starts else match_start_tick
        freeze_in_round = [t for t in freeze_ticks if start_tick <= t <= end_tick]
        freeze_end_tick = freeze_in_round[-1] if freeze_in_round else start_tick
        winner = _normalize_side(row.get("winner"))
        if winner == "CT":
            ct_score += 1
        elif winner == "T":
            t_score += 1
        parsed_ct = _col(row, "ct_score")
        parsed_t = _col(row, "t_score")
        if parsed_ct is not None:
            try:
                ct_score = int(parsed_ct)
            except (TypeError, ValueError):
                pass
        if parsed_t is not None:
            try:
                t_score = int(parsed_t)
            except (TypeError, ValueError):
                pass
        rounds.append(
            Round(
                index=len(rounds),
                start_tick=start_tick,
                freeze_end_tick=freeze_end_tick,
                end_tick=end_tick,
                winner=winner,
                ct_score=ct_score,
                t_score=t_score,
            )
        )
    return rounds


def get_slots(parser: DemoParser, sample_tick: int) -> dict[str, int]:
    try:
        df = parser.parse_ticks(["user_id"], ticks=[sample_tick])
    except Exception:
        return {}
    if df.empty or "user_id" not in df.columns:
        return {}
    slots: dict[str, int] = {}
    for row in df.to_dict("records"):
        steamid = canonicalize_steamid(row.get("steamid", ""))
        user_id = row.get("user_id")
        if steamid and pd.notna(user_id):
            slots[steamid] = int(user_id) + 1
    return slots


def parse_demo(path: Path) -> DemoData:
    parser = DemoParser(str(path))

    try:
        header = parser.parse_header()
    except Exception:
        header = {}
    map_name = str(header.get("map_name", "unknown"))

    events = _load_match_events(parser)
    new_match = events["begin_new_match"]
    match_start_tick = 0
    if not new_match.empty and "tick" in new_match.columns:
        match_start_tick = int(new_match["tick"].max())

    deaths_df = events["player_death"]
    if deaths_df.empty:
        raise ValueError("No player_death events found — is this a valid CS2 demo?")
    deaths_df = deaths_df.sort_values("tick")

    rounds = _build_rounds(
        events["round_start"],
        events["round_end"],
        events["round_freeze_end"],
        match_start_tick,
    )
    if not rounds:
        raise ValueError("No round_end events found — demo looks incomplete")
    round_start_ticks = [r.start_tick for r in rounds]

    def round_index_for_tick(tick: int) -> int:
        idx = bisect_right(round_start_ticks, tick) - 1
        return max(0, idx)

    kills: list[Kill] = []
    deaths: list[Death] = []
    for row in deaths_df.to_dict("records"):
        tick = int(row["tick"])
        if tick < match_start_tick:
            continue
        if bool(_col(row, "is_warmup_period", False)):
            continue
        victim_steamid = canonicalize_steamid(_col(row, "user_steamid", ""))
        round_index = round_index_for_tick(tick)
        if victim_steamid:
            deaths.append(Death(tick=tick, round_index=round_index, victim_steamid=victim_steamid))

        attacker_steamid = canonicalize_steamid(_col(row, "attacker_steamid", ""))
        if not attacker_steamid or attacker_steamid == victim_steamid:
            continue
        attacker_side = _normalize_side(_col(row, "attacker_team_name", ""))
        victim_side = _normalize_side(_col(row, "user_team_name", ""))
        if attacker_side and victim_side and attacker_side == victim_side:
            continue
        kills.append(
            Kill(
                tick=tick,
                round_index=round_index,
                attacker_steamid=attacker_steamid,
                attacker_name=str(_col(row, "attacker_name", "") or ""),
                attacker_side=attacker_side,
                victim_steamid=victim_steamid,
                victim_name=str(_col(row, "user_name", "") or ""),
                weapon=str(_col(row, "weapon", "") or ""),
                headshot=bool(_col(row, "headshot", False)),
                noscope=bool(_col(row, "noscope", False)),
                penetrated=int(_col(row, "penetrated", 0) or 0),
                thrusmoke=bool(_col(row, "thrusmoke", False)),
                attackerblind=bool(_col(row, "attackerblind", False)),
                assister_steamid=canonicalize_steamid(_col(row, "assister_steamid", "")),
            )
        )

    player_names: dict[str, str] = {}
    try:
        info = parser.parse_player_info()
        for row in info.to_dict("records"):
            steamid = canonicalize_steamid(row.get("steamid", ""))
            if steamid:
                player_names[steamid] = str(row.get("name", "") or steamid)
    except Exception:
        pass
    for kill in kills:
        player_names.setdefault(kill.attacker_steamid, kill.attacker_name)
        player_names.setdefault(kill.victim_steamid, kill.victim_name)

    death_ticks = [d.tick for d in deaths]
    sample_ticks = [r.freeze_end_tick + 16 for r in rounds]
    slot_tick = rounds[0].freeze_end_tick + 16
    rate_ticks: list[int] = []
    if len(death_ticks) >= 2:
        t1, t2 = min(death_ticks), max(death_ticks)
        if t2 - t1 >= 256:
            rate_ticks = [t1, t2]
    sampled = _sample_player_rows(parser, [*sample_ticks, slot_tick, *rate_ticks])
    tickrate = _tickrate_from_rows(sampled, rate_ticks[0], rate_ticks[1]) if rate_ticks else None
    if tickrate is None:
        tickrate = _compute_tickrate(parser, death_ticks)
    last_tick = max(
        rounds[-1].end_tick,
        death_ticks[-1] if death_ticks else 0,
    ) + int(10 * tickrate)

    rosters = _rosters_from_rows(sampled, rounds)
    if rosters is None:
        rosters = _build_rosters(parser, rounds)
    slots = _slots_from_rows(sampled, slot_tick)
    if slots is None:
        slots = get_slots(parser, slot_tick)
    damage_by_player = _build_damage(events["player_hurt"], match_start_tick)

    return DemoData(
        path=path,
        map_name=map_name,
        tickrate=tickrate,
        kills=kills,
        deaths=deaths,
        rounds=rounds,
        player_names=player_names,
        slots=slots,
        rosters=rosters,
        damage_by_player=damage_by_player,
        match_start_tick=match_start_tick,
        last_tick=last_tick,
    )


def _build_rosters(parser: DemoParser, rounds: list[Round]) -> dict[int, dict[str, str]]:
    sample_by_tick: dict[int, int] = {}
    for r in rounds:
        sample_by_tick[r.freeze_end_tick + 16] = r.index
    try:
        df = parser.parse_ticks(["is_alive", "team_num"], ticks=list(sample_by_tick.keys()))
    except Exception:
        return {}
    rosters: dict[int, dict[str, str]] = {r.index: {} for r in rounds}
    if df.empty:
        return rosters
    for row in df.to_dict("records"):
        tick = int(row["tick"])
        round_index = sample_by_tick.get(tick)
        if round_index is None:
            continue
        if not bool(row.get("is_alive", False)):
            continue
        side = _normalize_side(row.get("team_num"))
        if side not in ("CT", "T"):
            continue
        steamid = canonicalize_steamid(row.get("steamid", ""))
        if steamid:
            rosters[round_index][steamid] = side
    return rosters


def _build_damage(hurts: pd.DataFrame, match_start_tick: int) -> dict[str, int]:
    totals: dict[str, int] = {}
    if hurts.empty:
        return totals
    if "tick" in hurts.columns:
        hurts = hurts[hurts["tick"] >= match_start_tick]
    for row in hurts.to_dict("records"):
        tick = int(_col(row, "tick", 0) or 0)
        if tick < match_start_tick:
            continue
        if bool(_col(row, "is_warmup_period", False)):
            continue
        attacker = canonicalize_steamid(_col(row, "attacker_steamid", ""))
        victim = canonicalize_steamid(_col(row, "user_steamid", ""))
        if not attacker or attacker == victim:
            continue
        dmg = int(_col(row, "dmg_health", 0) or 0)
        totals[attacker] = totals.get(attacker, 0) + dmg
    return totals
