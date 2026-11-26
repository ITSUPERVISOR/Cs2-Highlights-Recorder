"""Per-clip player poses for the in-app 3D preview (no CS2 client)."""

from __future__ import annotations

import hashlib
import json
import pickle
from pathlib import Path

import pandas as pd
from demoparser2 import DemoParser

from reel_core.config import app_data_dir
from reel_core.demo.parser import DEFAULT_TICKRATE, _safe_event, ensure_dem_file
from reel_core.steamids import canonicalize_steamid

STRIDE = 2

# Bumped whenever the dump payload gains fields. Cached dumps from an older
# schema would otherwise be re-served without them and nothing would appear.
SCHEMA = 6

# The AK's reload animation runs 2.433s, so a reload that began shortly before
# the window is still playing inside it. Equips and zooms are instantaneous but
# set state that persists, so they get the same treatment.
EVENT_LOOKBACK_SECONDS = 3.0

POSE_FIELDS = (
    "X",
    "Y",
    "Z",
    "pitch",
    "yaw",
    "is_alive",
    "health",
    "team_num",
    "active_weapon_name",
    "weapon_name",
)

# demoparser's `ducking` alias walks much more of the file than the raw crouch
# amount, even for a handful of ticks. The amount rides along with the other
# props. The boolean is only read when a demo has no amount.
DUCK_AMOUNT = "CCSPlayerPawn.CCSPlayer_MovementServices.m_flDuckAmount"

# Raw netprops for the extras. These are parsed apart from POSE_FIELDS: the
# pose fallback ladder drops whole field *sets*, so bundling these in would mean
# one unsupported prop costs us pitch and yaw too.
PUNCH_FIELD = "CCSPlayerPawn.CCSPlayer_CameraServices.m_vecCsViewPunchAngle"
EXTRA_FIELDS = (
    PUNCH_FIELD,
    "CCSPlayerPawn.m_bIsScoped",
    "CCSPlayerPawn.m_bIsWalking",
    DUCK_AMOUNT,
    "CCSPlayerPawn.m_ArmorValue",
    "CCSPlayerPawn.m_szLastPlaceName",
    "active_weapon_skin",
    "fall_back_paint_kit",
)

# One demo pass for every event the clip needs. A second call used to rescan
# the file for each of these names.
CLIP_EVENTS = (
    "fire_bullets",
    "weapon_fire",
    "bullet_damage",
    "player_hurt",
    "player_blind",
    "weapon_reload",
    "item_equip",
    "weapon_zoom",
    "smokegrenade_detonate",
    "smokegrenade_expired",
    "inferno_startburn",
    "inferno_expire",
    "hegrenade_detonate",
    "flashbang_detonate",
    "bomb_planted",
    "bomb_dropped",
    "bomb_pickup",
    "bomb_defused",
    "bomb_exploded",
    "round_end",
    "round_officially_ended",
    "begin_new_match",
)


class _EventSource:
    """Events for one clip, read in a single pass when the parser allows it."""

    def __init__(self, parser: DemoParser) -> None:
        self._parser = parser
        self._events: dict[str, pd.DataFrame] | None = None

    def load(self, names: tuple[str, ...] | list[str], demo_path: Path | None = None) -> None:
        cache = _event_cache_path(demo_path, names)
        if cache is not None and cache.is_file():
            loaded = _read_event_cache(cache)
            if loaded is not None:
                self._events = loaded
                return
        parse_events = getattr(self._parser, "parse_events", None)
        if parse_events is None:
            return
        # Player positions let bomb plants keep their coordinates. If a build
        # rejects that, the names alone are still one pass.
        for kwargs in ({"player": ["X", "Y", "Z"]}, {}):
            try:
                pairs = parse_events(list(names), **kwargs)
            except Exception:
                continue
            loaded: dict[str, pd.DataFrame] = {}
            for item in pairs or []:
                if not isinstance(item, tuple) or len(item) != 2:
                    continue
                name, frame = item
                loaded[str(name)] = frame if isinstance(frame, pd.DataFrame) else pd.DataFrame()
            for name in names:
                loaded.setdefault(str(name), pd.DataFrame())
            self._events = loaded
            if cache is not None:
                _write_event_cache(cache, loaded)
            return

    def event(self, name: str, **kwargs) -> pd.DataFrame:
        if kwargs or self._events is None:
            return _safe_event(self._parser, name, **kwargs)
        frame = self._events.get(name)
        return frame if isinstance(frame, pd.DataFrame) else pd.DataFrame()

    def parse_grenades(self):
        return self._parser.parse_grenades()

    def parse_event(self, name: str, **kwargs):
        return self.event(name, **kwargs)

    def __getattr__(self, name: str):
        return getattr(self._parser, name)


def _event_cache_path(demo_path: Path | None, names: tuple[str, ...] | list[str]) -> Path | None:
    """Clip events are the same for every window, so the scan is saved per demo."""
    if demo_path is None or tuple(names) != CLIP_EVENTS:
        return None
    try:
        stat = demo_path.stat()
    except OSError:
        return None
    raw = f"{demo_path.resolve()}|{stat.st_mtime_ns}|{stat.st_size}|clip-events|v1"
    key = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:20]
    return preview_cache_dir() / f"events-{key}.pkl"


def _read_event_cache(path: Path) -> dict[str, pd.DataFrame] | None:
    try:
        loaded = pickle.loads(path.read_bytes())
    except Exception:
        return None
    if not isinstance(loaded, dict) or any(name not in loaded for name in CLIP_EVENTS):
        return None
    if any(not isinstance(frame, pd.DataFrame) for frame in loaded.values()):
        return None
    return loaded


def _write_event_cache(path: Path, loaded: dict[str, pd.DataFrame]) -> None:
    try:
        path.write_bytes(pickle.dumps(loaded, protocol=pickle.HIGHEST_PROTOCOL))
    except Exception:
        pass


def _event(parser: DemoParser, name: str, **kwargs) -> pd.DataFrame:
    batched = getattr(parser, "event", None)
    if batched is not None and not kwargs:
        return batched(name)
    return _safe_event(parser, name, **kwargs)


def preview_cache_dir() -> Path:
    path = app_data_dir() / "previews"
    path.mkdir(parents=True, exist_ok=True)
    return path


def cache_key(demo_path: Path, start_tick: int, end_tick: int, pov: str, stride: int) -> str:
    try:
        stamp = f"{demo_path.stat().st_mtime_ns}:{demo_path.stat().st_size}"
    except OSError:
        stamp = demo_path.name
    raw = f"{demo_path.resolve()}|{stamp}|{start_tick}|{end_tick}|{pov}|{stride}|v{SCHEMA}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:20]


_MISSING = object()


def _cell(row: pd.Series | dict, name: str):
    if isinstance(row, dict):
        if name not in row:
            return _MISSING
        return row[name]
    if name not in row.index:
        return _MISSING
    return row[name]


def _num(row: pd.Series | dict, *names: str, default: float = 0.0) -> float:
    for name in names:
        value = _cell(row, name)
        if value is _MISSING:
            continue
        try:
            if pd.isna(value):
                continue
        except (TypeError, ValueError):
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return default


def _bool(row: pd.Series | dict, *names: str, default: bool = True) -> bool:
    for name in names:
        value = _cell(row, name)
        if value is _MISSING:
            continue
        try:
            if pd.isna(value):
                continue
        except (TypeError, ValueError):
            continue
        if isinstance(value, str):
            return value.lower() not in ("0", "false", "no")
        return bool(value)
    return default


def _str(row: pd.Series | dict, *names: str) -> str:
    for name in names:
        value = _cell(row, name)
        if value is _MISSING:
            continue
        try:
            if pd.isna(value):
                continue
        except (TypeError, ValueError):
            continue
        text = str(value).strip()
        if text and text.lower() != "nan":
            return text
    return ""


def _vec(row: pd.Series | dict, name: str, index: int, default: float = 0.0) -> float:
    """One component of a QAngle/Vector prop, which arrives as a 3-element list."""
    value = _cell(row, name)
    if value is _MISSING or not isinstance(value, (list, tuple)) or len(value) <= index:
        return default
    item = value[index]
    try:
        if pd.isna(item):
            return default
        return float(item)
    except (TypeError, ValueError):
        return default


def _records(df: pd.DataFrame) -> list[dict]:
    """Row dicts. Much cheaper than DataFrame.iterrows on a clip's poses."""
    if df is None or df.empty:
        return []
    return df.to_dict("records")


def _records_between(df: pd.DataFrame, floor: int, end: int) -> list[dict]:
    """Rows whose tick is inside the clip, without walking the rest of the match."""
    if df is None or df.empty or "tick" not in df.columns:
        return []
    window = df[(df["tick"] >= floor) & (df["tick"] <= end)]
    if window.empty:
        return []
    if not window["tick"].is_monotonic_increasing:
        window = window.sort_values("tick")
    return window.to_dict("records")


def _team(row: pd.Series) -> str:
    num = int(_num(row, "team_num", default=0))
    if num == 2:
        return "T"
    if num == 3:
        return "CT"
    return ""


def _duck_boolean(parser: DemoParser, ticks: list[int]) -> pd.DataFrame:
    """Slow crouch boolean, used only when the demo has no crouch amount."""
    try:
        df = parser.parse_ticks(["ducking"], ticks=ticks)
    except Exception:
        return pd.DataFrame()
    if df is None or df.empty or "ducking" not in df.columns:
        return pd.DataFrame()
    keep = [column for column in ("tick", "steamid", "ducking") if column in df.columns]
    if len(keep) < 3:
        return pd.DataFrame()
    return df[keep]


def _with_duck_fallback(parser: DemoParser, ticks: list[int], df: pd.DataFrame) -> pd.DataFrame:
    if df.empty or DUCK_AMOUNT in df.columns or "ducking" in df.columns:
        return df
    return _merge_extras(df, _duck_boolean(parser, ticks))


def _parse_clip_ticks(parser: DemoParser, ticks: list[int]) -> pd.DataFrame:
    """Poses and optional props in one read, falling back to separate reads."""
    combined = list(dict.fromkeys([*POSE_FIELDS, *EXTRA_FIELDS]))
    try:
        df = parser.parse_ticks(combined, ticks=ticks)
    except Exception:
        df = None
    if df is not None and not df.empty and "X" in df.columns:
        return _with_duck_fallback(parser, ticks, df)
    return _with_duck_fallback(
        parser,
        ticks,
        _merge_extras(_parse_pose_ticks(parser, ticks), _parse_extra_ticks(parser, ticks)),
    )


def _parse_pose_ticks(parser: DemoParser, ticks: list[int]) -> pd.DataFrame:
    last_error: Exception | None = None
    for fields in (list(POSE_FIELDS), ["X", "Y", "Z", "pitch", "yaw"], ["X", "Y", "Z"]):
        try:
            df = parser.parse_ticks(fields, ticks=ticks)
        except Exception as exc:
            last_error = exc
            continue
        if df is not None and not df.empty and "X" in df.columns:
            return df
    if last_error:
        raise RuntimeError(f"Could not parse player positions from this demo: {last_error}") from last_error
    raise RuntimeError("Could not parse player positions from this demo")


def _parse_extra_ticks(parser: DemoParser, ticks: list[int]) -> pd.DataFrame:
    """Optional per-tick props, keyed by (tick, steamid) for merging onto poses.

    Tries them together first, then one at a time, so a demo that lacks a single
    prop still yields the rest instead of none. Returns empty on total failure;
    the extras are all optional by design.
    """
    try:
        df = parser.parse_ticks(list(EXTRA_FIELDS), ticks=ticks)
        if df is not None and not df.empty and "tick" in df.columns:
            return df.drop(columns=[c for c in ("name",) if c in df.columns])
    except Exception:
        pass

    merged: pd.DataFrame | None = None
    for field in EXTRA_FIELDS:
        try:
            part = parser.parse_ticks([field], ticks=ticks)
        except Exception:
            continue
        if part is None or part.empty:
            continue
        keep = [c for c in ("tick", "steamid", field) if c in part.columns]
        if len(keep) < 3:
            continue
        part = part[keep]
        merged = part if merged is None else merged.merge(part, on=["tick", "steamid"], how="outer")
    return merged if merged is not None else pd.DataFrame()


def _merge_extras(poses: pd.DataFrame, extras: pd.DataFrame) -> pd.DataFrame:
    if extras.empty or "tick" not in extras.columns or "steamid" not in extras.columns:
        return poses
    if "steamid" not in poses.columns:
        return poses
    try:
        return poses.merge(extras, on=["tick", "steamid"], how="left")
    except Exception:
        # A dtype mismatch on steamid should cost the extras, not the poses.
        return poses


def frames_from_dataframe(df: pd.DataFrame) -> list[dict]:
    frames: list[dict] = []
    if df.empty or "tick" not in df.columns:
        return frames
    ordered = df if df["tick"].is_monotonic_increasing else df.sort_values("tick")
    current: int | None = None
    players: dict[str, dict] = {}
    for row in ordered.to_dict("records"):
        try:
            tick = int(row.get("tick"))
        except (TypeError, ValueError):
            continue
        if current is None:
            current = tick
        elif tick != current:
            if players:
                frames.append({"tick": current, "players": players})
            players = {}
            current = tick
        steamid = canonicalize_steamid(row.get("steamid", ""))
        if not steamid:
            continue
        alive = _bool(row, "is_alive", default=True)
        health = _num(row, "health", default=100.0)
        if health <= 0:
            alive = False
        duck_amount = _num(row, DUCK_AMOUNT, default=-1.0)
        has_duck_bool = _cell(row, "ducking") is not _MISSING or _cell(row, "is_ducking") is not _MISSING
        ducking = _bool(row, "ducking", "is_ducking", default=False)
        if duck_amount < 0:
            # No duck amount in this demo: fall back to the boolean.
            duck_amount = 1.0 if ducking else 0.0
        elif not has_duck_bool:
            ducking = duck_amount > 0
        players[steamid] = {
            "x": round(_num(row, "X"), 2),
            "y": round(_num(row, "Y"), 2),
            "z": round(_num(row, "Z"), 2),
            "pitch": round(_num(row, "pitch"), 2),
            "yaw": round(_num(row, "yaw"), 2),
            "alive": alive,
            "ducking": ducking,
            "weapon": _str(row, "active_weapon_name", "weapon_name"),
            "team": _team(row),
            "name": _str(row, "name"),
            # Extras. Absent props collapse to harmless defaults.
            "health": round(health),
            "armor": round(_num(row, "CCSPlayerPawn.m_ArmorValue", default=0.0)),
            "duck": round(min(1.0, max(0.0, duck_amount)), 3),
            "punchPitch": round(_vec(row, PUNCH_FIELD, 0), 3),
            "punchYaw": round(_vec(row, PUNCH_FIELD, 1), 3),
            "scoped": _bool(row, "CCSPlayerPawn.m_bIsScoped", default=False),
            "walking": _bool(row, "CCSPlayerPawn.m_bIsWalking", default=False),
            "place": _str(row, "CCSPlayerPawn.m_szLastPlaceName"),
            "skin": _str(row, "active_weapon_skin"),
            "paintKit": int(_num(row, "fall_back_paint_kit", default=0.0)),
        }
    if current is not None and players:
        frames.append({"tick": current, "players": players})
    return frames


def _mark_punch_impulses(frames: list[dict], shots: list[dict]) -> None:
    """Date each view-punch impulse so the renderer can decay it.

    `m_vecCsViewPunchAngle` is not a per-tick decaying angle. It is the impulse
    *seed*: it latches at the shot tick and is then held unchanged until the next
    shot, with the client doing the decay. Feeding it straight to the camera would
    leave a permanent aim offset for the rest of the clip.

    The impulse is dated from the shot ticks rather than by watching the value
    change, because recoil seeds are deterministic: a burst of first shots latches
    the same number every time and changes would go unnoticed. Sharing a source
    with the tracers also keeps the kick and the bullet in step. `punchAge` of -1
    means nothing has been fired yet and the latched value predates the clip.
    """
    by_player: dict[str, list[int]] = {}
    for shot in shots:
        by_player.setdefault(str(shot["steamid"]), []).append(int(shot["tick"]))
    for ticks in by_player.values():
        ticks.sort()

    cursor: dict[str, int] = {}
    latest: dict[str, int] = {}
    for frame in frames:
        tick = int(frame["tick"])
        for steamid, pose in frame["players"].items():
            fired = by_player.get(steamid)
            if fired:
                i = cursor.get(steamid, 0)
                while i < len(fired) and fired[i] <= tick:
                    latest[steamid] = fired[i]
                    i += 1
                cursor[steamid] = i
            at = latest.get(steamid)
            pose["punchAge"] = -1 if at is None else tick - at


def _index_by_shooter(df: pd.DataFrame, id_col: str) -> dict[tuple[str, int], pd.Series]:
    """Index event rows by (steamid, tick) for joining onto fire_bullets."""
    index: dict[tuple[str, int], dict | pd.Series] = {}
    if df.empty or "tick" not in df.columns or id_col not in df.columns:
        return index
    for row in _records(df):
        steamid = canonicalize_steamid(_str(row, id_col))
        if not steamid:
            continue
        try:
            tick = int(row["tick"])
        except (TypeError, ValueError):
            continue
        index.setdefault((steamid, tick), row)
    return index


def _nearest_event(
    index: dict[tuple[str, int], dict | pd.Series], steamid: str, tick: int
) -> dict | pd.Series | None:
    """Same shot, allowing a tick of slack between the paired events."""
    for offset in (0, -1, 1):
        row = index.get((steamid, tick + offset))
        if row is not None:
            return row
    return None


def _shots_in_window(parser: DemoParser, start_tick: int, end_tick: int) -> list[dict]:
    """Bullets fired in the window, with exact origin and angles.

    `fire_bullets` carries the geometry but not the weapon name; `weapon_fire`
    carries the name but no geometry; `bullet_damage` says how far the bullet
    actually travelled. Knives and grenades appear only in `weapon_fire`, so
    driving off `fire_bullets` correctly yields no tracer for them.
    """
    fires = _event(parser, "fire_bullets")
    if fires.empty or "tick" not in fires.columns:
        return []
    window = fires[(fires["tick"] >= start_tick) & (fires["tick"] <= end_tick)]
    if window.empty:
        return []

    names = _index_by_shooter(_event(parser, "weapon_fire"), "user_steamid")
    damage = _index_by_shooter(_event(parser, "bullet_damage"), "attacker_steamid")
    hurts = _index_by_shooter(_event(parser, "player_hurt"), "attacker_steamid")

    shots: list[dict] = []
    for row in _records(window):
        steamid = canonicalize_steamid(_str(row, "user_steamid"))
        if not steamid:
            continue
        tick = int(row["tick"])
        fired = _nearest_event(names, steamid, tick)
        hit = _nearest_event(damage, steamid, tick)
        hurt = _nearest_event(hurts, steamid, tick)
        distance = _num(hit, "distance", default=-1.0) if hit is not None else -1.0
        dealt = 0.0
        if hit is not None:
            dealt = _num(hit, "dmg_health", "damage_health", "damage", default=0.0)
        if dealt <= 0 and hurt is not None:
            dealt = _num(hurt, "dmg_health", "dmg_health_real", "damage", default=0.0)
        shots.append(
            {
                "tick": tick,
                "steamid": steamid,
                "weapon": _str(fired, "weapon") if fired is not None else "",
                "silenced": _bool(fired, "silenced", default=False) if fired is not None else False,
                "ox": round(_num(row, "origin_x"), 2),
                "oy": round(_num(row, "origin_y"), 2),
                "oz": round(_num(row, "origin_z"), 2),
                "pitch": round(_num(row, "angles_x"), 2),
                "yaw": round(_num(row, "angles_y"), 2),
                "dist": round(distance, 1) if distance > 0 else None,
                "victim": (canonicalize_steamid(_str(hit, "victim_steamid")) or None)
                if hit is not None
                else (
                    canonicalize_steamid(_str(hurt, "user_steamid", "victim_steamid")) or None
                    if hurt is not None
                    else None
                ),
                "damage": int(round(dealt)) if dealt > 0 else None,
            }
        )
    return shots


def _is_grenade_weapon(name: str) -> bool:
    key = name.lower().replace("weapon_", "").replace("-", "_").replace(" ", "")
    return key in {
        "hegrenade",
        "flashbang",
        "smokegrenade",
        "molotov",
        "incgrenade",
        "incendiarygrenade",
        "incendiary",
        "decoy",
    }


def _throws_in_window(
    parser: DemoParser, start_tick: int, end_tick: int, lookback_ticks: int = 0
) -> list[dict]:
    """Grenade `weapon_fire` events. Kept off `shots` so they do not spawn tracers."""
    df = _event(parser, "weapon_fire")
    if df.empty or "tick" not in df.columns:
        return []
    floor = int(start_tick) - max(0, int(lookback_ticks))
    out: list[dict] = []
    for row in _records_between(df, floor, end_tick):
        try:
            tick = int(row["tick"])
        except (TypeError, ValueError):
            continue
        weapon = _str(row, "weapon")
        if not _is_grenade_weapon(weapon):
            continue
        steamid = canonicalize_steamid(_str(row, "user_steamid"))
        if not steamid:
            continue
        out.append({"tick": tick, "steamid": steamid, "weapon": weapon})
    return out


def _blinds_in_window(
    parser: DemoParser, start_tick: int, end_tick: int, tickrate: float
) -> list[dict]:
    """Flash blindness per player, with the exact duration each of them suffered.

    Taken from `player_blind` rather than the per-tick props, because
    `m_flFlashDuration` shows up for a single snapshot and then reads 0 while
    `m_flFlashMaxAlpha` latches at 255 and never clears, so neither can drive a
    fade. The event also gives each victim their own duration: the same flashbang
    blinds one player for 0.13s and another for 3.09s.
    """
    df = _event(parser, "player_blind")
    if df.empty or "tick" not in df.columns:
        return []
    rate = max(float(tickrate), 1.0)
    out: list[dict] = []
    for row in _records_between(df, df["tick"].min(), end_tick):
        try:
            tick = int(row["tick"])
        except (TypeError, ValueError):
            continue
        duration = _num(row, "blind_duration", default=0.0)
        if duration <= 0:
            continue
        # A long blind that started before the window is still on screen in it.
        if tick + duration * rate < start_tick:
            continue
        steamid = canonicalize_steamid(_str(row, "user_steamid"))
        if not steamid:
            continue
        out.append({"tick": tick, "steamid": steamid, "duration": round(duration, 3)})
    return out


def _player_events(
    parser: DemoParser,
    name: str,
    start_tick: int,
    end_tick: int,
    *,
    lookback_ticks: int = 0,
    text_fields: tuple[str, ...] = (),
    bool_fields: tuple[str, ...] = (),
) -> list[dict]:
    """Simple ``(tick, steamid)`` events, optionally carrying a few extra columns.

    Used for `weapon_reload`, `item_equip` and `weapon_zoom`. These are real
    events rather than netprops, which matters: the scoped state was previously
    read from `m_bIsScoped`, and `item_equip` fires thousands of times at round
    start, so the window filter is not optional.
    """
    df = _event(parser, name)
    if df.empty or "tick" not in df.columns:
        return []
    floor = int(start_tick) - max(0, int(lookback_ticks))
    out: list[dict] = []
    for row in _records_between(df, floor, end_tick):
        try:
            tick = int(row["tick"])
        except (TypeError, ValueError):
            continue
        steamid = canonicalize_steamid(_str(row, "user_steamid"))
        if not steamid:
            continue
        event: dict = {"tick": tick, "steamid": steamid}
        for field in text_fields:
            value = _str(row, field)
            if value:
                event[field] = value
        for field in bool_fields:
            event[field] = _bool(row, field, default=False)
        out.append(event)
    return out


def _nade_kind(raw: str) -> str:
    key = raw.lower()
    if "flash" in key:
        return "flash"
    if "smoke" in key:
        return "smoke"
    if "molotov" in key or "incendiary" in key or "inferno" in key:
        return "molotov"
    if "decoy" in key:
        return "decoy"
    if "he" in key or "frag" in key:
        return "he"
    return "other"


# Thrown grenades only need a flight path when one of these already-loaded events
# lands near the clip. Otherwise parse_grenades would rescan the whole demo.
_FLIGHT_EVENTS = (
    "weapon_fire",
    "hegrenade_detonate",
    "flashbang_detonate",
    "smokegrenade_detonate",
    "inferno_startburn",
)
_PROJECTILE_COLUMNS = ["tick", "x", "y", "z", "grenade_type", "grenade_entity_id"]


def _grenade_cache_path(demo_path: Path) -> Path | None:
    try:
        stat = demo_path.stat()
    except OSError:
        return None
    raw = f"{demo_path.resolve()}|{stat.st_mtime_ns}|{stat.st_size}|grenade-flights|v1"
    key = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:20]
    return preview_cache_dir() / f"grenades-{key}.parquet"


def _clip_needs_grenade_flights(parser: DemoParser, start_tick: int, end_tick: int) -> bool:
    """False when this clip's events are already loaded and none are grenades.

    A parser that has not loaded events yet still needs the flight scan. Guessing
    from a partial event set would hide a grenade that is in the air.
    """
    loaded = getattr(parser, "_events", None)
    if not isinstance(loaded, dict) or any(name not in loaded for name in _FLIGHT_EVENTS):
        return True
    floor = int(start_tick) - int(4 * DEFAULT_TICKRATE)
    ceiling = int(end_tick) + int(2 * DEFAULT_TICKRATE)
    fires = loaded["weapon_fire"]
    if isinstance(fires, pd.DataFrame) and not fires.empty and {"tick", "weapon"}.issubset(fires.columns):
        window = fires[(fires["tick"] >= floor) & (fires["tick"] <= ceiling)]
        if not window.empty and window["weapon"].astype(str).map(_is_grenade_weapon).any():
            return True
    for name in _FLIGHT_EVENTS[1:]:
        frame = loaded[name]
        if not isinstance(frame, pd.DataFrame) or frame.empty or "tick" not in frame.columns:
            continue
        ticks = frame["tick"]
        if ((ticks >= floor) & (ticks <= ceiling)).any():
            return True
    return False


def _projectile_rows(df: pd.DataFrame) -> pd.DataFrame:
    """Airborne projectiles only. Inventory rows have no position."""
    if df is None or df.empty or not set(_PROJECTILE_COLUMNS).issubset(df.columns):
        return pd.DataFrame(columns=_PROJECTILE_COLUMNS)
    kinds = df["grenade_type"].astype(str)
    kept = df.loc[kinds.str.endswith("Projectile"), _PROJECTILE_COLUMNS]
    return kept.dropna(subset=["x", "y", "z", "grenade_entity_id"])


def _load_projectile_rows(parser: DemoParser, demo_path: Path | None) -> pd.DataFrame:
    """Grenade flights for the whole demo, reused by later clips of the same file."""
    cache = _grenade_cache_path(demo_path) if demo_path is not None else None
    if cache is not None and cache.is_file():
        try:
            cached = pd.read_parquet(cache)
        except Exception:
            cached = None
        if isinstance(cached, pd.DataFrame):
            return cached
    try:
        raw = parser.parse_grenades()
    except Exception:
        return pd.DataFrame(columns=_PROJECTILE_COLUMNS)
    table = _projectile_rows(raw if isinstance(raw, pd.DataFrame) else pd.DataFrame())
    if cache is not None:
        try:
            table.to_parquet(cache, index=False)
        except Exception:
            pass
    return table


def _grenades_in_window(
    parser: DemoParser,
    start_tick: int,
    end_tick: int,
    stride: int,
    demo_path: Path | None = None,
) -> list[dict]:
    """Flight paths of airborne grenades, one entry per projectile entity.

    `parse_grenades` reports both the inventory item (`CFlashbang`) and the
    thrown projectile (`CFlashbangProjectile`). Only the latter is in flight; the
    item rows carry NaN positions. The projectile table is cached per demo because
    reading it scans the whole file.
    """
    if not _clip_needs_grenade_flights(parser, start_tick, end_tick):
        return []
    df = _load_projectile_rows(parser, demo_path)
    if df.empty or not set(_PROJECTILE_COLUMNS).issubset(df.columns):
        return []
    df = df[(df["tick"] >= start_tick) & (df["tick"] <= end_tick)]
    if df.empty:
        return []
    kinds = df["grenade_type"].astype(str)
    df = df[kinds.str.endswith("Projectile")]
    if df.empty:
        return []

    step = max(1, int(stride))
    out: list[dict] = []
    for entity, group in df.groupby("grenade_entity_id", sort=True):
        group = group.sort_values("tick")
        rows = group.sort_values("tick").to_dict("records")
        points = [
            {
                "tick": int(row["tick"]),
                "x": round(float(row["x"]), 1),
                "y": round(float(row["y"]), 1),
                "z": round(float(row["z"]), 1),
            }
            for i, row in enumerate(rows)
            if i % step == 0 or i == len(rows) - 1
        ]
        if len(points) < 2:
            continue
        out.append(
            {
                "id": int(entity),
                "kind": _nade_kind(str(group.iloc[0]["grenade_type"])),
                "points": points,
            }
        )
    return out


def _detonations(parser: DemoParser, name: str) -> pd.DataFrame:
    """One of the grenade effect events, all of which share entityid/tick/x/y/z."""
    df = _event(parser, name)
    if df.empty or not {"tick", "x", "y", "z"}.issubset(set(df.columns)):
        return pd.DataFrame()
    return df.dropna(subset=["x", "y", "z"])


def _timed_volumes(
    parser: DemoParser, start_event: str, end_event: str, start_tick: int, end_tick: int
) -> list[dict]:
    """Smokes and fires active during the window, paired start to expiry.

    A smoke lasts far longer than a clip, so one that detonated before the window
    is still on screen during it. Selection is by interval overlap, not by
    detonation tick.
    """
    starts = _detonations(parser, start_event)
    if starts.empty:
        return []
    ends = _detonations(parser, end_event)

    expiry: dict[int, list[int]] = {}
    if not ends.empty and "entityid" in ends.columns:
        for row in _records(ends.sort_values("tick")):
            try:
                expiry.setdefault(int(row["entityid"]), []).append(int(row["tick"]))
            except (TypeError, ValueError):
                continue

    out: list[dict] = []
    for row in _records_between(starts, int(starts["tick"].min()), end_tick):
        tick = int(row["tick"])
        entity = None
        if "entityid" in starts.columns:
            try:
                entity = int(row["entityid"])
            except (TypeError, ValueError):
                entity = None
        # Entity ids are reused across a match, so take the first expiry at or
        # after this detonation.
        end = next((t for t in expiry.get(entity, []) if t >= tick), None) if entity is not None else None
        if end is not None and end < start_tick:
            continue
        out.append(
            {
                "id": entity,
                "tick": tick,
                "endTick": end,
                "x": round(float(row["x"]), 1),
                "y": round(float(row["y"]), 1),
                "z": round(float(row["z"]), 1),
            }
        )
    return out


def _event_ticks(parser: DemoParser, name: str) -> list[int]:
    df = _event(parser, name)
    if df.empty or "tick" not in df.columns:
        return []
    out: list[int] = []
    for value in df["tick"]:
        try:
            out.append(int(value))
        except (TypeError, ValueError):
            continue
    return out


def _event_xyz(row: pd.Series) -> tuple[float, float, float] | None:
    x = _num(row, "user_X", "x", "X")
    y = _num(row, "user_Y", "y", "Y")
    z = _num(row, "user_Z", "z", "Z")
    if x == 0.0 and y == 0.0 and z == 0.0:
        return None
    return (x, y, z)


def _pose_xyz(frames: list[dict], tick: int, steamid: str) -> tuple[float, float, float] | None:
    if not steamid:
        return None
    best: dict | None = None
    for frame in frames:
        if int(frame.get("tick") or 0) > tick:
            break
        pose = (frame.get("players") or {}).get(steamid)
        if pose:
            best = pose
    if not best:
        return None
    return (float(best.get("x") or 0), float(best.get("y") or 0), float(best.get("z") or 0))


def _bomb_starts(parser: DemoParser, name: str) -> list[dict]:
    """Plant/drop events with the carrier's position at that tick."""
    df = _event(parser, name)
    if df.empty or "tick" not in df.columns:
        return []
    out: list[dict] = []
    for row in _records(df):
        try:
            tick = int(row["tick"])
        except (TypeError, ValueError):
            continue
        xyz = _event_xyz(row)
        steamid = canonicalize_steamid(_str(row, "user_steamid"))
        item: dict = {"tick": tick, "steamid": steamid}
        if xyz:
            item["x"], item["y"], item["z"] = (round(v, 1) for v in xyz)
        out.append(item)
    return out


def _next_at_or_after(ticks: list[int], start: int) -> int | None:
    return next((t for t in ticks if t >= start), None)


def _bombs_in_window(
    parser: DemoParser, start_tick: int, end_tick: int, frames: list[dict]
) -> list[dict]:
    """World C4 while it is on the ground or planted, overlapping the clip.

    One bomb at a time. A drop that was picked up before the window is omitted
    the same way a spent smoke is; a plant from before the window stays visible.
    """
    planted = _bomb_starts(parser, "bomb_planted")
    dropped = _bomb_starts(parser, "bomb_dropped")
    if not planted and not dropped:
        return []

    pickups = _event_ticks(parser, "bomb_pickup")
    defused = _event_ticks(parser, "bomb_defused")
    exploded = _event_ticks(parser, "bomb_exploded")
    round_over = (
        _event_ticks(parser, "round_end")
        + _event_ticks(parser, "round_officially_ended")
        + _event_ticks(parser, "begin_new_match")
    )
    plant_ticks = [row["tick"] for row in planted]
    drop_ends = sorted(pickups + plant_ticks + round_over)
    plant_ends = sorted(defused + exploded + round_over)

    out: list[dict] = []
    for kind, starts, ends in (
        ("dropped", dropped, drop_ends),
        ("planted", planted, plant_ends),
    ):
        for row in starts:
            tick = int(row["tick"])
            if tick > end_tick:
                continue
            end = _next_at_or_after(ends, tick)
            if end is not None and end < start_tick:
                continue
            xyz = None
            if "x" in row:
                xyz = (row["x"], row["y"], row["z"])
            if xyz is None:
                xyz = _pose_xyz(frames, tick, str(row.get("steamid") or ""))
            if xyz is None:
                continue
            out.append(
                {
                    "kind": kind,
                    "tick": tick,
                    "endTick": end,
                    "x": round(float(xyz[0]), 1),
                    "y": round(float(xyz[1]), 1),
                    "z": round(float(xyz[2]), 1),
                }
            )
    out.sort(key=lambda item: item["tick"])
    return out


def _bursts(parser: DemoParser, start_tick: int, end_tick: int) -> list[dict]:

    """One-shot detonations: HE and flashbang."""
    out: list[dict] = []
    for kind, event in (("he", "hegrenade_detonate"), ("flash", "flashbang_detonate")):
        df = _detonations(parser, event)
        if df.empty:
            continue
        window = df[(df["tick"] >= start_tick) & (df["tick"] <= end_tick)]
        for row in _records(window):
            out.append(
                {
                    "kind": kind,
                    "tick": int(row["tick"]),
                    "x": round(float(row["x"]), 1),
                    "y": round(float(row["y"]), 1),
                    "z": round(float(row["z"]), 1),
                }
            )
    return out


def dump_clip_trajectory(
    demo_path: Path,
    *,
    start_tick: int,
    end_tick: int,
    pov_steamid: str,
    map_name: str = "",
    tickrate: float = DEFAULT_TICKRATE,
    stride: int = STRIDE,
) -> dict:
    if end_tick <= start_tick:
        raise ValueError("Clip window is empty")
    pov = canonicalize_steamid(pov_steamid)
    work = preview_cache_dir()
    dem = ensure_dem_file(demo_path, work / "dem")
    key = cache_key(dem, start_tick, end_tick, pov, stride)
    cache_file = work / f"{key}.json"
    if cache_file.is_file():
        try:
            # A cache hit must not parse the pose dump. The UI reads the file itself.
            if cache_file.stat().st_size > 64:
                with cache_file.open("rb") as handle:
                    cached_header = handle.read(1) == b"{"
                if cached_header:
                    return {
                        "cached": True,
                        "cachePath": str(cache_file),
                        "map": map_name,
                        "mapSource": "",
                        "frames": [],
                        "povSteamid": pov,
                    }
        except OSError:
            pass

    ticks = list(range(int(start_tick), int(end_tick) + 1, max(1, stride)))
    parser = _EventSource(DemoParser(str(dem)))
    parser.load(CLIP_EVENTS, dem)
    header = {}
    try:
        header = parser.parse_header() or {}
    except Exception:
        pass
    df = _parse_clip_ticks(parser, ticks)
    frames = frames_from_dataframe(df)
    if not frames:
        raise RuntimeError("No player positions in this clip window")

    # Everything below is optional colour: a demo without it still replays.
    shots = _shots_in_window(parser, int(start_tick), int(end_tick))
    _mark_punch_impulses(frames, shots)
    grenades = _grenades_in_window(parser, int(start_tick), int(end_tick), stride, dem)
    smokes = _timed_volumes(
        parser, "smokegrenade_detonate", "smokegrenade_expired", int(start_tick), int(end_tick)
    )
    fires = _timed_volumes(
        parser, "inferno_startburn", "inferno_expire", int(start_tick), int(end_tick)
    )
    bursts = _bursts(parser, int(start_tick), int(end_tick))
    blinds = _blinds_in_window(parser, int(start_tick), int(end_tick), tickrate)

    # Drive the real reload, draw and scope animations from events rather than
    # from latched props.
    lookback = int(EVENT_LOOKBACK_SECONDS * max(float(tickrate), 1.0))
    reloads = _player_events(
        parser, "weapon_reload", int(start_tick), int(end_tick), lookback_ticks=lookback
    )
    equips = _player_events(
        parser,
        "item_equip",
        int(start_tick),
        int(end_tick),
        lookback_ticks=lookback,
        text_fields=("item",),
        bool_fields=("issilenced",),
    )
    zooms = _player_events(
        parser, "weapon_zoom", int(start_tick), int(end_tick), lookback_ticks=lookback
    )
    throws = _throws_in_window(parser, int(start_tick), int(end_tick), lookback_ticks=lookback)
    bombs = _bombs_in_window(parser, int(start_tick), int(end_tick), frames)

    from reel_core.demo.map_assets import map_is_installed, resolve_map_gltf, resolve_map_stem

    resolved_map = resolve_map_stem(map_name or str(header.get("map_name") or "unknown"))
    gltf_path, map_source = resolve_map_gltf(resolved_map, frames, export=False)

    payload = {
        "tickrate": float(tickrate) or DEFAULT_TICKRATE,
        "map": resolved_map,
        "mapInstalled": map_is_installed(resolved_map),
        "povSteamid": pov,
        "startTick": int(start_tick),
        "endTick": int(end_tick),
        "stride": max(1, stride),
        "frames": frames,
        "shots": shots,
        "grenades": grenades,
        "smokes": smokes,
        "fires": fires,
        "bursts": bursts,
        "blinds": blinds,
        "reloads": reloads,
        "equips": equips,
        "zooms": zooms,
        "throws": throws,
        "bombs": bombs,
        "mapGltf": str(gltf_path) if gltf_path else None,
        "mapSource": map_source,
        "cachePath": str(cache_file),
    }
    cache_file.write_text(json.dumps(payload), encoding="utf-8")
    return payload
