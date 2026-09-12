from conftest import make_demo, make_kill, make_round
from reel_core.demo.parser import Death
from reel_core.analysis.clutch import detect_clutches
from reel_core.models import Kill


def test_detects_won_1v2():
    rounds = [make_round(0, 0, 5000, winner="CT")]
    roster = {
        0: {
            "ct1": "CT",
            "ct2": "CT",
            "t1": "T",
            "t2": "T",
        }
    }
    deaths = [
        Death(tick=1100, round_index=0, victim_steamid="ct2"),
        Death(tick=1200, round_index=0, victim_steamid="t1"),
        Death(tick=1300, round_index=0, victim_steamid="t2"),
    ]
    kills = [
        Kill(
            tick=1200,
            round_index=0,
            attacker_steamid="ct1",
            attacker_name="hero",
            attacker_side="CT",
            victim_steamid="t1",
            victim_name="t1",
            weapon="ak47",
        ),
        Kill(
            tick=1300,
            round_index=0,
            attacker_steamid="ct1",
            attacker_name="hero",
            attacker_side="CT",
            victim_steamid="t2",
            victim_name="t2",
            weapon="ak47",
        ),
    ]
    demo = make_demo(kills, rounds, deaths=deaths, rosters=roster)
    clutches = detect_clutches(demo)
    ct = next(c for c in clutches if c.steamid == "ct1")
    assert ct.opponents == 2
    assert ct.won is True
