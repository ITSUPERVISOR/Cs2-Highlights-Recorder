"""The first preview should read the demo in as few passes as it can."""

import pandas as pd

from reel_core.demo import trajectory
from reel_core.demo.trajectory import CLIP_EVENTS, PUNCH_FIELD

ALICE = "76561198000000001"


class _TickParser:
    def __init__(self, fail_combined: bool = False):
        self.calls: list[list[str]] = []
        self.fail_combined = fail_combined

    def parse_ticks(self, fields, ticks=None):
        self.calls.append(list(fields))
        if self.fail_combined and PUNCH_FIELD in fields:
            raise RuntimeError("prop missing")
        return pd.DataFrame({"tick": [1], "steamid": [ALICE], "X": [1.0]})


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
