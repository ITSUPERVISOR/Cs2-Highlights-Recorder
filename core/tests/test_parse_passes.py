"""A match summary should scan the demo once for events and once for sample ticks."""

import pandas as pd

from reel_core.demo.parser import parse_demo

ALICE = "76561198000000001"
BOB = "76561198000000002"


def _frames() -> dict[str, pd.DataFrame]:
    return {
        "begin_new_match": pd.DataFrame([{"tick": 100}]),
        "round_start": pd.DataFrame([{"tick": 500}]),
        "round_freeze_end": pd.DataFrame([{"tick": 700}]),
        "round_end": pd.DataFrame([{"tick": 2000, "winner": "T"}]),
        "player_death": pd.DataFrame(
            [
                {
                    "tick": 1000,
                    "user_steamid": BOB,
                    "user_name": "Bob",
                    "user_team_name": "CT",
                    "attacker_steamid": ALICE,
                    "attacker_name": "Alice",
                    "attacker_team_name": "T",
                    "weapon": "ak47",
                    "headshot": True,
                    "noscope": False,
                    "penetrated": 0,
                    "thrusmoke": False,
                    "attackerblind": False,
                    "assister_steamid": None,
                    "is_warmup_period": False,
                }
            ]
        ),
        "player_hurt": pd.DataFrame(
            [
                {
                    "tick": 900,
                    "attacker_steamid": ALICE,
                    "user_steamid": BOB,
                    "dmg_health": 27,
                    "is_warmup_period": False,
                }
            ]
        ),
    }


class _BatchParser:
    instances: list["_BatchParser"] = []

    def __init__(self, _path: str):
        self.event_passes = 0
        self.tick_passes = 0
        self.single_events: list[str] = []
        type(self).instances.append(self)

    def parse_header(self):
        return {"map_name": "de_inferno"}

    def parse_events(self, names, **_kwargs):
        self.event_passes += 1
        frames = _frames()
        return [(name, frames[name]) for name in names if name in frames]

    def parse_event(self, name, **_kwargs):
        self.single_events.append(name)
        return _frames().get(name, pd.DataFrame())

    def parse_player_info(self):
        return pd.DataFrame([{"steamid": ALICE, "name": "Alice"}, {"steamid": BOB, "name": "Bob"}])

    def parse_ticks(self, _fields, ticks=None):
        self.tick_passes += 1
        rows = []
        for tick in ticks or []:
            rows.append(
                {"tick": tick, "steamid": ALICE, "user_id": 0, "team_num": 2, "is_alive": True, "game_time": tick / 64}
            )
            rows.append(
                {"tick": tick, "steamid": BOB, "user_id": 1, "team_num": 3, "is_alive": True, "game_time": tick / 64}
            )
        return pd.DataFrame(rows)


class _SingleParser(_BatchParser):
    instances: list["_BatchParser"] = []

    def parse_events(self, _names, **_kwargs):
        raise RuntimeError("batch unavailable")


def test_match_events_and_ticks_are_one_pass_each(monkeypatch, tmp_path):
    _BatchParser.instances = []
    monkeypatch.setattr("reel_core.demo.parser.DemoParser", _BatchParser)
    demo = parse_demo(tmp_path / "match.dem")
    parser = _BatchParser.instances[-1]
    assert parser.event_passes == 1
    assert parser.single_events == []
    assert parser.tick_passes == 1
    assert demo.map_name == "de_inferno"
    assert demo.tickrate == 64
    assert len(demo.rounds) == 1
    assert demo.rounds[0].winner == "T"
    assert demo.rounds[0].t_score == 1
    assert len(demo.kills) == 1
    assert demo.kills[0].attacker_name == "Alice"
    assert demo.kills[0].headshot is True
    assert demo.damage_by_player[ALICE] == 27
    assert demo.slots[ALICE] == 1
    assert demo.slots[BOB] == 2
    assert demo.rosters[0][ALICE] == "T"
    assert demo.rosters[0][BOB] == "CT"
    assert demo.player_names[ALICE] == "Alice"


def test_match_events_fall_back_to_single_reads(monkeypatch, tmp_path):
    _SingleParser.instances = []
    monkeypatch.setattr("reel_core.demo.parser.DemoParser", _SingleParser)
    demo = parse_demo(tmp_path / "match.dem")
    parser = _SingleParser.instances[-1]
    assert parser.event_passes == 0
    assert set(parser.single_events) >= {"player_death", "round_end", "player_hurt"}
    assert parser.tick_passes == 1
    assert len(demo.kills) == 1
    assert demo.damage_by_player[ALICE] == 27
