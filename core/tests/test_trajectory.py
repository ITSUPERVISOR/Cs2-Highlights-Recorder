import json
import subprocess
from pathlib import Path

import pandas as pd

from reel_core.demo import map_assets, trajectory
from reel_core.demo.map_assets import resolve_map_gltf, write_fallback_gltf
from reel_core.demo.trajectory import cache_key, frames_from_dataframe


class FakeParser:
    """Stands in for DemoParser, serving canned events and grenade rows."""

    def __init__(self, events: dict[str, pd.DataFrame] | None = None, grenades=None):
        self._events = events or {}
        self._grenades = grenades

    def parse_event(self, name: str, **_kwargs):
        return self._events.get(name)

    def parse_grenades(self):
        if self._grenades is None:
            raise RuntimeError("this demo has no grenade data")
        return self._grenades


def test_frames_from_dataframe_groups_players():
    df = pd.DataFrame(
        [
            {
                "tick": 100,
                "steamid": "76561198000000001",
                "X": 10,
                "Y": 20,
                "Z": 30,
                "pitch": 1,
                "yaw": 90,
                "is_alive": True,
                "team_num": 3,
                "active_weapon_name": "ak47",
                "name": "Alice",
            },
            {
                "tick": 100,
                "steamid": "76561198000000002",
                "X": 1,
                "Y": 2,
                "Z": 3,
                "pitch": 0,
                "yaw": 0,
                "is_alive": False,
                "team_num": 2,
                "weapon_name": "glock",
                "name": "Bob",
            },
        ]
    )
    frames = frames_from_dataframe(df)
    assert len(frames) == 1
    assert frames[0]["tick"] == 100
    alice = frames[0]["players"]["76561198000000001"]
    assert alice["x"] == 10
    assert alice["team"] == "CT"
    assert alice["weapon"] == "ak47"
    assert frames[0]["players"]["76561198000000002"]["alive"] is False


def test_frames_from_dataframe_falls_back_to_duck_boolean():
    """A demo without the duck amount still crouches, just without the easing."""
    df = pd.DataFrame(
        [
            {
                "tick": 1,
                "steamid": "76561198000000001",
                "X": 0,
                "Y": 0,
                "Z": 0,
                "ducking": True,
            }
        ]
    )
    pose = frames_from_dataframe(df)[0]["players"]["76561198000000001"]
    assert pose["ducking"] is True
    assert pose["duck"] == 1.0
    # Absent extras must not blow up or leak NaN into the payload.
    assert pose["punchPitch"] == 0.0
    assert pose["scoped"] is False
    assert pose["place"] == ""


def test_frames_from_dataframe_reads_duck_amount():
    df = pd.DataFrame(
        [
            {
                "tick": 1,
                "steamid": "76561198000000001",
                "X": 0,
                "Y": 0,
                "Z": 0,
                "ducking": False,
                "CCSPlayerPawn.CCSPlayer_MovementServices.m_flDuckAmount": 0.4,
                trajectory.PUNCH_FIELD: [-1.25, 0.5, 0.0],
                "CCSPlayerPawn.m_szLastPlaceName": "Banana",
            }
        ]
    )
    pose = frames_from_dataframe(df)[0]["players"]["76561198000000001"]
    assert pose["duck"] == 0.4
    assert pose["punchPitch"] == -1.25
    assert pose["punchYaw"] == 0.5
    assert pose["place"] == "Banana"


def test_cache_key_changes_with_window(tmp_path: Path):
    demo = tmp_path / "a.dem"
    demo.write_bytes(b"demo")
    a = cache_key(demo, 1, 100, "1", 2)
    b = cache_key(demo, 1, 200, "1", 2)
    assert a != b


def test_cache_key_changes_with_schema(tmp_path: Path, monkeypatch):
    """Dumps from an older schema must be rebuilt, not re-served without shots."""
    demo = tmp_path / "a.dem"
    demo.write_bytes(b"demo")
    before = cache_key(demo, 1, 100, "1", 2)
    monkeypatch.setattr(trajectory, "SCHEMA", trajectory.SCHEMA + 1)
    assert cache_key(demo, 1, 100, "1", 2) != before


ALICE = "76561198000000001"
BOB = "76561198000000002"


def _fire_bullets(rows: list[dict]) -> pd.DataFrame:
    return pd.DataFrame(rows)


def test_shots_join_weapon_name_and_hit_distance():
    parser = FakeParser(
        {
            "fire_bullets": _fire_bullets(
                [
                    {
                        "tick": 100,
                        "user_steamid": ALICE,
                        "origin_x": 10.0,
                        "origin_y": 20.0,
                        "origin_z": 64.0,
                        "angles_x": 3.5,
                        "angles_y": 170.0,
                    },
                    {
                        "tick": 200,
                        "user_steamid": ALICE,
                        "origin_x": 11.0,
                        "origin_y": 21.0,
                        "origin_z": 64.0,
                        "angles_x": 1.0,
                        "angles_y": 90.0,
                    },
                ]
            ),
            # weapon_fire also carries the knife swing, which must not become a shot.
            "weapon_fire": pd.DataFrame(
                [
                    {"tick": 100, "user_steamid": ALICE, "weapon": "weapon_ak47", "silenced": False},
                    {"tick": 200, "user_steamid": ALICE, "weapon": "weapon_ak47", "silenced": False},
                    {"tick": 300, "user_steamid": BOB, "weapon": "weapon_knife", "silenced": False},
                    {"tick": 400, "user_steamid": BOB, "weapon": "weapon_hegrenade", "silenced": False},
                ]
            ),
            "bullet_damage": pd.DataFrame(
                [{"tick": 100, "attacker_steamid": ALICE, "victim_steamid": BOB, "distance": 812.5}]
            ),
        }
    )
    shots = trajectory._shots_in_window(parser, 0, 1000)
    assert len(shots) == 2

    hit, miss = shots
    assert hit["weapon"] == "weapon_ak47"
    assert hit["ox"] == 10.0
    assert hit["pitch"] == 3.5
    assert hit["yaw"] == 170.0
    assert hit["dist"] == 812.5
    assert hit["victim"] == BOB
    # A miss has no recorded distance, so the renderer draws a long streak.
    assert miss["dist"] is None
    assert miss["victim"] is None


def test_grenade_weapon_fire_is_a_throw_not_a_shot():
    parser = FakeParser(
        {
            "fire_bullets": _fire_bullets([]),
            "weapon_fire": pd.DataFrame(
                [
                    {"tick": 300, "user_steamid": BOB, "weapon": "weapon_knife", "silenced": False},
                    {"tick": 400, "user_steamid": BOB, "weapon": "weapon_hegrenade", "silenced": False},
                    {"tick": 500, "user_steamid": ALICE, "weapon": "weapon_incgrenade", "silenced": False},
                    {"tick": 600, "user_steamid": ALICE, "weapon": "weapon_ak47", "silenced": False},
                ]
            ),
        }
    )
    throws = trajectory._throws_in_window(parser, 0, 1000)
    assert [(t["tick"], t["steamid"], t["weapon"]) for t in throws] == [
        (400, BOB, "weapon_hegrenade"),
        (500, ALICE, "weapon_incgrenade"),
    ]
    assert trajectory._shots_in_window(parser, 0, 1000) == []


def test_throws_respect_the_window_with_lookback():
    parser = FakeParser(
        {
            "weapon_fire": pd.DataFrame(
                [
                    {"tick": 50, "user_steamid": ALICE, "weapon": "weapon_flashbang"},
                    {"tick": 400, "user_steamid": ALICE, "weapon": "weapon_smokegrenade"},
                    {"tick": 900, "user_steamid": ALICE, "weapon": "weapon_molotov"},
                ]
            ),
        }
    )
    throws = trajectory._throws_in_window(parser, 200, 500, lookback_ticks=200)
    assert [t["tick"] for t in throws] == [50, 400]


def test_shots_tolerate_a_tick_of_slack_between_paired_events():
    parser = FakeParser(
        {
            "fire_bullets": _fire_bullets(
                [
                    {
                        "tick": 100,
                        "user_steamid": ALICE,
                        "origin_x": 0.0,
                        "origin_y": 0.0,
                        "origin_z": 0.0,
                        "angles_x": 0.0,
                        "angles_y": 0.0,
                    }
                ]
            ),
            "weapon_fire": pd.DataFrame(
                [{"tick": 101, "user_steamid": ALICE, "weapon": "weapon_awp", "silenced": False}]
            ),
        }
    )
    assert trajectory._shots_in_window(parser, 0, 1000)[0]["weapon"] == "weapon_awp"


def test_shots_outside_the_window_are_dropped():
    parser = FakeParser(
        {
            "fire_bullets": _fire_bullets(
                [
                    {
                        "tick": 10,
                        "user_steamid": ALICE,
                        "origin_x": 0.0,
                        "origin_y": 0.0,
                        "origin_z": 0.0,
                        "angles_x": 0.0,
                        "angles_y": 0.0,
                    },
                    {
                        "tick": 500,
                        "user_steamid": ALICE,
                        "origin_x": 0.0,
                        "origin_y": 0.0,
                        "origin_z": 0.0,
                        "angles_x": 0.0,
                        "angles_y": 0.0,
                    },
                ]
            )
        }
    )
    shots = trajectory._shots_in_window(parser, 100, 400)
    assert shots == []


def test_shots_missing_events_yield_nothing():
    assert trajectory._shots_in_window(FakeParser(), 0, 100) == []


def test_grenades_skip_inventory_rows():
    """Only *Projectile rows are airborne; the item rows carry NaN positions."""
    grenades = pd.DataFrame(
        [
            {"grenade_type": "CFlashbang", "grenade_entity_id": 1, "x": None, "y": None, "z": None, "tick": 10},
            {"grenade_type": "CFlashbang", "grenade_entity_id": 1, "x": None, "y": None, "z": None, "tick": 11},
            {"grenade_type": "CFlashbangProjectile", "grenade_entity_id": 2, "x": 1.0, "y": 2.0, "z": 3.0, "tick": 10},
            {"grenade_type": "CFlashbangProjectile", "grenade_entity_id": 2, "x": 4.0, "y": 5.0, "z": 6.0, "tick": 11},
        ]
    )
    out = trajectory._grenades_in_window(FakeParser(grenades=grenades), 0, 100, 1)
    assert len(out) == 1
    assert out[0]["id"] == 2
    assert out[0]["kind"] == "flash"
    assert len(out[0]["points"]) == 2


def test_grenades_need_two_points_to_be_a_flight():
    grenades = pd.DataFrame(
        [
            {"grenade_type": "CSmokeGrenadeProjectile", "grenade_entity_id": 3, "x": 1.0, "y": 1.0, "z": 1.0, "tick": 10},
        ]
    )
    assert trajectory._grenades_in_window(FakeParser(grenades=grenades), 0, 100, 1) == []


def test_grenades_absent_when_unsupported():
    assert trajectory._grenades_in_window(FakeParser(), 0, 100, 2) == []


def test_smoke_active_before_the_window_is_kept():
    """A smoke outlasts a clip, so one that popped earlier is still on screen."""
    parser = FakeParser(
        {
            "smokegrenade_detonate": pd.DataFrame(
                [{"entityid": 7, "tick": 50, "x": 1.0, "y": 2.0, "z": 3.0}]
            ),
            "smokegrenade_expired": pd.DataFrame(
                [{"entityid": 7, "tick": 900, "x": 1.0, "y": 2.0, "z": 3.0}]
            ),
        }
    )
    out = trajectory._timed_volumes(
        parser, "smokegrenade_detonate", "smokegrenade_expired", 400, 800
    )
    assert len(out) == 1
    assert out[0]["tick"] == 50
    assert out[0]["endTick"] == 900


def test_smoke_expired_before_the_window_is_dropped():
    parser = FakeParser(
        {
            "smokegrenade_detonate": pd.DataFrame(
                [{"entityid": 7, "tick": 50, "x": 1.0, "y": 2.0, "z": 3.0}]
            ),
            "smokegrenade_expired": pd.DataFrame(
                [{"entityid": 7, "tick": 100, "x": 1.0, "y": 2.0, "z": 3.0}]
            ),
        }
    )
    assert (
        trajectory._timed_volumes(
            parser, "smokegrenade_detonate", "smokegrenade_expired", 400, 800
        )
        == []
    )


def test_blind_uses_per_player_duration():
    """One flashbang blinds each victim for a different length of time."""
    parser = FakeParser(
        {
            "player_blind": pd.DataFrame(
                [
                    {"tick": 100, "user_steamid": ALICE, "blind_duration": 0.13},
                    {"tick": 100, "user_steamid": BOB, "blind_duration": 3.09},
                    # Already over well before the window opens.
                    {"tick": 10, "user_steamid": ALICE, "blind_duration": 0.2},
                ]
            )
        }
    )
    out = trajectory._blinds_in_window(parser, 90, 300, 64)
    assert [(b["steamid"], b["duration"]) for b in out] == [
        (ALICE, 0.13),
        (BOB, 3.09),
    ]


def test_punch_impulses_are_dated_from_shot_ticks():
    """Recoil seeds repeat, so impulses come from the shots, not from value changes."""
    frames = [
        {"tick": t, "players": {ALICE: {"punchPitch": -1.265, "punchYaw": 0.0}}}
        for t in (100, 102, 104, 106)
    ]
    trajectory._mark_punch_impulses(frames, [{"tick": 102, "steamid": ALICE}])
    ages = [frame["players"][ALICE]["punchAge"] for frame in frames]
    # Nothing fired yet at tick 100, then the impulse ages tick by tick.
    assert ages == [-1, 0, 2, 4]


def test_punch_impulse_restarts_on_the_next_shot():
    frames = [
        {"tick": t, "players": {ALICE: {"punchPitch": -1.2, "punchYaw": 0.0}}}
        for t in (100, 102, 104, 106)
    ]
    trajectory._mark_punch_impulses(
        frames, [{"tick": 100, "steamid": ALICE}, {"tick": 104, "steamid": ALICE}]
    )
    assert [frame["players"][ALICE]["punchAge"] for frame in frames] == [0, 2, 0, 2]


class FieldParser:
    """parse_ticks that rejects specific fields, like an older demo would."""

    def __init__(self, unsupported: set[str]):
        self.unsupported = unsupported
        self.calls: list[list[str]] = []

    def parse_ticks(self, fields, ticks=None):
        self.calls.append(list(fields))
        bad = self.unsupported.intersection(fields)
        if bad:
            raise RuntimeError(f"unsupported: {sorted(bad)}")
        return pd.DataFrame(
            [{"tick": t, "steamid": ALICE, **{f: 1 for f in fields}} for t in (ticks or [])]
        )


def test_extra_fields_degrade_one_at_a_time():
    """Losing the view punch must not cost us the other extras."""
    parser = FieldParser({trajectory.PUNCH_FIELD})
    df = trajectory._parse_extra_ticks(parser, [1, 2])
    assert not df.empty
    assert trajectory.PUNCH_FIELD not in df.columns
    assert "CCSPlayerPawn.m_bIsScoped" in df.columns
    # Batch first, then a retry per field.
    assert len(parser.calls) == 1 + len(trajectory.EXTRA_FIELDS)


def test_extra_fields_batch_when_all_supported():
    parser = FieldParser(set())
    df = trajectory._parse_extra_ticks(parser, [1, 2])
    assert trajectory.PUNCH_FIELD in df.columns
    assert len(parser.calls) == 1


def test_extras_never_cost_us_the_poses():
    poses = pd.DataFrame([{"tick": 1, "steamid": ALICE, "X": 5.0}])
    merged = trajectory._merge_extras(poses, pd.DataFrame())
    assert merged["X"].iloc[0] == 5.0


def test_fallback_gltf_writes_mesh(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("CS2_REEL_HOME", str(tmp_path))
    frames = [
        {
            "tick": 1,
            "players": {
                "1": {"x": 100, "y": -50, "z": 10},
                "2": {"x": 200, "y": 50, "z": 20},
            },
        }
    ]
    path = write_fallback_gltf("de_inferno", frames)
    assert path.is_file()
    assert path.with_suffix(".bin").is_file()
    text = path.read_text(encoding="utf-8")
    assert "cs2-reel-fallback" in text


def test_resolve_map_gltf_fallback_without_viewer(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("CS2_REEL_HOME", str(tmp_path))
    monkeypatch.setattr("reel_core.demo.map_assets.find_source2viewer", lambda: None)
    monkeypatch.setattr("reel_core.demo.map_assets.find_map_vpk", lambda _name: None)
    frames = [{"tick": 1, "players": {"1": {"x": 0, "y": 0, "z": 0}}}]
    path, source = resolve_map_gltf("de_dust2", frames)
    assert source == "fallback"
    assert path.is_file()


def _cache_map(tmp_path: Path, name: str, meshes: dict[str, int], marker: dict | None) -> Path:
    dest = tmp_path / "maps" / name
    dest.mkdir(parents=True)
    for filename, size in meshes.items():
        (dest / filename).write_bytes(b"glTF" + b"\0" * size)
    if marker is not None:
        (dest / map_assets.MARKER_NAME).write_text(json.dumps(marker), encoding="utf-8")
    return dest


def _marker(**overrides) -> dict:
    base = {"kind": map_assets.EXPORT_KIND, "version": map_assets.EXPORT_VERSION, "cli": "x"}
    base.update(overrides)
    return base


def test_resolve_map_gltf_uses_cached_glb(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("CS2_REEL_HOME", str(tmp_path))
    dest = _cache_map(tmp_path, "de_mirage", {"de_mirage_physics.glb": 2000}, _marker())
    path, source = resolve_map_gltf("de_mirage", [])
    assert source == "collision"
    assert path == dest / "de_mirage_physics.glb"


def test_cached_glb_prefers_physics_export(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("CS2_REEL_HOME", str(tmp_path))
    dest = _cache_map(
        tmp_path,
        "de_nuke",
        {"de_nuke.glb": 5000, "de_nuke_physics.glb": 2000},
        _marker(),
    )
    path, _ = resolve_map_gltf("de_nuke", [])
    assert path == dest / "de_nuke_physics.glb"


def test_oversized_cached_mesh_is_rejected(tmp_path: Path, monkeypatch):
    """The 800 MB render-geometry export must never be served to the renderer."""
    monkeypatch.setenv("CS2_REEL_HOME", str(tmp_path))
    monkeypatch.setattr(map_assets, "MAX_MESH_BYTES", 4096)
    _cache_map(tmp_path, "de_inferno", {"de_inferno.glb": 99_999}, _marker())
    path, source = resolve_map_gltf("de_inferno", [])
    assert source == "fallback"
    assert path.name.endswith("-fallback.gltf")


def test_stale_marker_invalidates_cache(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("CS2_REEL_HOME", str(tmp_path))
    _cache_map(tmp_path, "de_anubis", {"de_anubis.glb": 2000}, _marker(kind="render", version=1))
    _, source = resolve_map_gltf("de_anubis", [])
    assert source == "fallback"


def test_missing_marker_invalidates_cache(tmp_path: Path, monkeypatch):
    """Exports written before the collision switch carry no marker at all."""
    monkeypatch.setenv("CS2_REEL_HOME", str(tmp_path))
    _cache_map(tmp_path, "de_ancient", {"de_ancient.glb": 2000}, None)
    _, source = resolve_map_gltf("de_ancient", [])
    assert source == "fallback"


def test_export_targets_collision_hull_and_clears_stale(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("CS2_REEL_HOME", str(tmp_path))
    dest = _cache_map(tmp_path, "de_train", {"de_train.glb": 99_999}, None)
    vpk = tmp_path / "de_train.vpk"
    vpk.write_bytes(b"vpk")
    cli = tmp_path / "Source2Viewer-CLI.exe"
    cli.write_bytes(b"cli")
    monkeypatch.setattr(map_assets, "find_source2viewer", lambda: cli)
    monkeypatch.setattr(map_assets, "find_map_vpk", lambda _name: vpk)
    monkeypatch.setattr(map_assets, "_gameinfo", lambda: None)

    calls: list[list[str]] = []

    def fake_run(args, **_kwargs):
        calls.append(args)
        (dest / "de_train_physics.glb").write_bytes(b"glTF" + b"\0" * 2000)
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(map_assets.subprocess, "run", fake_run)

    path, source = map_assets.export_map_gltf("de_train", [])
    assert source == "collision"
    assert path.name == "de_train_physics.glb"
    # Stale render export removed, not re-served.
    assert not (dest / "de_train.glb").exists()
    assert "maps/de_train/world_physics.vmdl_c" in calls[0]
    assert "--gltf_export_materials" not in calls[0]
    assert json.loads((dest / map_assets.MARKER_NAME).read_text())["kind"] == "collision"
