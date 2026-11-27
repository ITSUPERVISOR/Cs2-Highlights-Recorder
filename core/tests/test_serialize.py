from pathlib import Path

from conftest import make_demo, make_kill, make_round

from reel_core.analysis import analyze
from reel_core.config import Config
from reel_core.serialize import library_demo, parse_payload, sequences_from_library


def test_parse_payload_has_round_cards():
    rounds = [make_round(0, 0, 10000, winner="CT"), make_round(1, 10000, 20000, winner="T")]
    kills = [
        make_kill(1200, victim="1"),
        make_kill(1300, victim="2"),
        make_kill(1400, victim="3"),
        make_kill(1500, victim="4"),
        make_kill(1600, victim="5"),
    ]
    demo = make_demo(kills, rounds)
    moments, sequences, stats = analyze(demo, Config(), "111")
    payload = parse_payload(demo, moments, sequences, stats, "111")
    assert payload["map"] == "de_mirage"
    assert payload["you"]["kills"] == 5
    assert payload["highlightCount"] >= 1
    assert payload["rounds"][0]["moments"]
    assert "ACE" in payload["rounds"][0]["labels"]
    assert payload["slots"] == demo.slots
    assert sequences[0].filename.endswith(".mp4")


def test_library_demo_reuses_slots_without_a_parse():
    rounds = [make_round(0, 0, 5000)]
    kills = [make_kill(1200), make_kill(1300)]
    demo = make_demo(kills, rounds, slots={"111": 3, "222": 7})
    moments, sequences, stats = analyze(demo, Config(), "111")
    payload = parse_payload(demo, moments, sequences, stats, "111")
    restored = library_demo(Path("match.dem"), payload)
    assert restored is not None
    assert restored.path == Path("match.dem")
    assert restored.slots == {"111": 3, "222": 7}
    assert restored.tickrate == demo.tickrate
    assert restored.player_names["111"].startswith("player")
    assert library_demo(Path("match.dem"), {"map": "de_mirage"}) is None


def test_sequences_from_library_keep_only_the_queued_moment():
    rounds = [make_round(0, 0, 8000), make_round(1, 8000, 16000)]
    kills = [make_kill(1500, victim="1"), make_kill(1600, victim="2"), make_kill(9000, round_index=1)]
    demo = make_demo(kills, rounds)
    moments, sequences, stats = analyze(demo, Config(), None)
    payload = parse_payload(demo, moments, sequences, stats, None)
    wanted = payload["moments"][0]["id"]
    chosen = sequences_from_library(payload, {wanted})
    assert chosen
    assert all(
        wanted in (payload["sequences"][sequence.number - 1]["momentIds"])
        for sequence in chosen
    )
    assert len(chosen) < len(sequences_from_library(payload, set())) or len(payload["sequences"]) == 1
    assert chosen[0].cameras[0].steamid
    assert chosen[0].end_tick > chosen[0].start_tick
