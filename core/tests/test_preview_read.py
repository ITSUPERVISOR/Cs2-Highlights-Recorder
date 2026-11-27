"""The first preview should read the demo in as few passes as it can."""

import pandas as pd

from reel_core.demo import trajectory
from reel_core.demo.trajectory import CLIP_EVENTS, DUCK_AMOUNT, PUNCH_FIELD

ALICE = "76561198000000001"


class _TickParser:
    def __init__(self, fail_combined: bool = False, duck_amount: bool = True):
        self.calls: list[list[str]] = []
        self.fail_combined = fail_combined
        self.duck_amount = duck_amount

    def parse_ticks(self, fields, ticks=None):
        self.calls.append(list(fields))
        if self.fail_combined and PUNCH_FIELD in fields:
            raise RuntimeError("prop missing")
        row = {"tick": 1, "steamid": ALICE, "X": 1.0}
        if self.duck_amount and fields == ["ducking"]:
            row["ducking"] = True
        elif self.duck_amount:
            row[DUCK_AMOUNT] = 0.0
        return pd.DataFrame([row])


class _EventParser:
    def __init__(self, fail: bool = False):
        self.passes = 0
        self.fail = fail
        self._events = {
            "weapon_fire": pd.DataFrame(
                [{"tick": 10, "user_steamid": ALICE, "weapon": "weapon_hegrenade"}]
            ),
            "player_blind": pd.DataFrame(
                [{"tick": 12, "user_steamid": ALICE, "blind_duration": 1.5}]
            ),
        }

    def parse_events(self, names, **_kwargs):
        self.passes += 1
        if self.fail:
            raise RuntimeError("batch unavailable")
        return [(name, self._events[name]) for name in names if name in self._events]

    def parse_event(self, name, **_kwargs):
        self.passes += 1
        return self._events.get(name)


def test_clip_ticks_are_one_read_when_every_prop_exists():
    parser = _TickParser()
    frame = trajectory._parse_clip_ticks(parser, [1])
    assert list(frame["X"]) == [1.0]
    assert parser.calls == [list(dict.fromkeys([*trajectory.POSE_FIELDS, *trajectory.EXTRA_FIELDS]))]


def test_missing_duck_amount_reads_the_boolean_once():
    parser = _TickParser(duck_amount=False)
    trajectory._parse_clip_ticks(parser, [1])
    assert parser.calls[0] == list(dict.fromkeys([*trajectory.POSE_FIELDS, *trajectory.EXTRA_FIELDS]))
    assert "ducking" not in parser.calls[0]
    assert parser.calls[1] == ["ducking"]


def test_duck_amount_marks_a_crouch_without_the_boolean():
    frames = trajectory.frames_from_dataframe(
        pd.DataFrame(
            [
                {
                    "tick": 1,
                    "steamid": ALICE,
                    "X": 0,
                    "Y": 0,
                    "Z": 0,
                    DUCK_AMOUNT: 1,
                }
            ]
        )
    )
    pose = frames[0]["players"][ALICE]
    assert pose["duck"] == 1
    assert pose["ducking"] is True


def test_clip_ticks_fall_back_when_the_combined_read_fails():
    parser = _TickParser(fail_combined=True)
    frame = trajectory._parse_clip_ticks(parser, [1])
    assert list(frame["X"]) == [1.0]
    assert len(parser.calls) > 1
    assert PUNCH_FIELD not in parser.calls[-1]


def test_events_are_read_once_and_reused():
    parser = _EventParser()
    source = trajectory._EventSource(parser)
    source.load(CLIP_EVENTS)
    throws = trajectory._throws_in_window(source, 0, 100)
    blinds = trajectory._blinds_in_window(source, 0, 100, 64)
    assert [item["weapon"] for item in throws] == ["weapon_hegrenade"]
    assert blinds[0]["duration"] == 1.5
    assert parser.passes == 1


def test_frames_group_players_without_iterrows():
    frame = trajectory.frames_from_dataframe(
        pd.DataFrame(
            [
                {
                    "tick": 200,
                    "steamid": ALICE,
                    "X": 4,
                    "Y": 5,
                    "Z": 6,
                    "pitch": 1,
                    "yaw": 2,
                    "is_alive": True,
                    "health": 80,
                    "team_num": 2,
                    "weapon_name": "ak47",
                    "name": "Alice",
                },
                {
                    "tick": 100,
                    "steamid": ALICE,
                    "X": 1,
                    "Y": 2,
                    "Z": 3,
                    "is_alive": True,
                    "team_num": 3,
                    "active_weapon_name": "glock",
                    "name": "Alice",
                },
            ]
        )
    )
    assert [item["tick"] for item in frame] == [100, 200]
    assert frame[0]["players"][ALICE]["weapon"] == "glock"
    assert frame[0]["players"][ALICE]["team"] == "CT"
    assert frame[1]["players"][ALICE]["weapon"] == "ak47"
    assert frame[1]["players"][ALICE]["health"] == 80
    parser = _EventParser(fail=True)
    source = trajectory._EventSource(parser)
    source.load(CLIP_EVENTS)
    throws = trajectory._throws_in_window(source, 0, 100)
    assert throws[0]["tick"] == 10
    assert parser.passes == 3


def test_quiet_clip_does_not_scan_grenade_flights():
    loaded = {name: pd.DataFrame(columns=["tick", "weapon", "x", "y", "z"]) for name in trajectory._FLIGHT_EVENTS}
    calls = {"n": 0}

    class Counting:
        def parse_grenades(self):
            calls["n"] += 1
            return pd.DataFrame()

    parser = trajectory._EventSource(Counting())
    parser._events = loaded

    assert trajectory._grenades_in_window(parser, 1000, 1200, 2) == []
    assert calls["n"] == 0


def test_grenade_flights_are_reused_for_the_same_demo(tmp_path, monkeypatch):
    monkeypatch.setattr(trajectory, "preview_cache_dir", lambda: tmp_path)
    demo = tmp_path / "match.dem"
    demo.write_bytes(b"not a real demo")
    grenades = pd.DataFrame(
        [
            {"grenade_type": "CFlashbang", "grenade_entity_id": 1, "x": None, "y": None, "z": None, "tick": 10},
            {"grenade_type": "CFlashbangProjectile", "grenade_entity_id": 2, "x": 1.0, "y": 2.0, "z": 3.0, "tick": 10},
            {"grenade_type": "CFlashbangProjectile", "grenade_entity_id": 2, "x": 4.0, "y": 5.0, "z": 6.0, "tick": 12},
            {"grenade_type": "CFlashbangProjectile", "grenade_entity_id": 2, "x": 9.0, "y": 9.0, "z": 9.0, "tick": 80},
        ]
    )
    calls = {"n": 0}

    class Counting:
        def parse_grenades(self):
            calls["n"] += 1
            return grenades

    class Boom:
        def parse_grenades(self):
            raise AssertionError("grenade flights were scanned again")

    first = trajectory._grenades_in_window(Counting(), 0, 20, 1, demo)
    assert calls["n"] == 1
    assert len(first) == 1
    assert [point["tick"] for point in first[0]["points"]] == [10, 12]
    second = trajectory._grenades_in_window(Boom(), 0, 20, 1, demo)
    assert second == first


def test_warm_preview_scans_a_demo_once(tmp_path, monkeypatch):
    monkeypatch.setattr(trajectory, "preview_cache_dir", lambda: tmp_path)
    demo = tmp_path / "match.dem"
    demo.write_bytes(b"demo")
    calls = {"events": 0, "grenades": 0}

    class Parser:
        def __init__(self, _path: str):
            pass

        def parse_events(self, names, **_kwargs):
            calls["events"] += 1
            return [
                (name, pd.DataFrame([{"tick": 1, "weapon": "ak47", "user_steamid": ALICE}]))
                for name in names
            ]

        def parse_grenades(self):
            calls["grenades"] += 1
            return pd.DataFrame(columns=["tick", "x", "y", "z", "grenade_type", "grenade_entity_id"])

    monkeypatch.setattr(trajectory, "DemoParser", Parser)
    first = trajectory.warm_preview_caches(demo)
    second = trajectory.warm_preview_caches(demo)
    assert first == {"ok": True, "events": True, "grenades": 0}
    assert second == first
    assert calls == {"events": 1, "grenades": 1}


def test_clip_events_are_reused_for_the_same_demo(tmp_path, monkeypatch):
    monkeypatch.setattr(trajectory, "preview_cache_dir", lambda: tmp_path)
    demo = tmp_path / "match.dem"
    demo.write_bytes(b"demo")
    parser = _EventParser()
    source = trajectory._EventSource(parser)
    source.load(CLIP_EVENTS, demo)
    assert parser.passes == 1
    assert trajectory._throws_in_window(source, 0, 100)[0]["tick"] == 10

    class Boom:
        def parse_events(self, _names, **_kwargs):
            raise AssertionError("events were scanned again")

    again = trajectory._EventSource(Boom())
    again.load(CLIP_EVENTS, demo)
    assert trajectory._throws_in_window(again, 0, 100)[0]["tick"] == 10
