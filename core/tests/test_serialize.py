from conftest import make_demo, make_kill, make_round

from reel_core.analysis import analyze
from reel_core.config import Config
from reel_core.serialize import parse_payload


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
    assert sequences[0].filename.endswith(".mp4")
