from conftest import TICKRATE, make_demo, make_kill, make_round

from reel_core.analysis.labels import clip_filename, labels_for_moment
from reel_core.analysis.moments import cluster_moments
from reel_core.models import Clutch


def test_ace_fast_labels():
    rounds = [make_round(0, 0, 100000)]
    kills = [make_kill(1000 + i * 32, victim=str(i)) for i in range(5)]
    demo = make_demo(kills, rounds)
    moment = cluster_moments(kills, TICKRATE)[0]
    labels = labels_for_moment(moment, demo)
    assert "ACE" in labels
    assert "fast" in labels


def test_spread_4k_and_clutch_label():
    rounds = [make_round(0, 0, 200000)]
    # 15s+ between first and later kills at 64 tick
    kills = [
        make_kill(1000, victim="1"),
        make_kill(1000 + 16 * 64, victim="2"),
        make_kill(1000 + 32 * 64, victim="3"),
        make_kill(1000 + 48 * 64, victim="4"),
    ]
    demo = make_demo(kills, rounds)
    moment = cluster_moments(kills, TICKRATE, gap_seconds=60)[0]
    moment.clutch = Clutch("111", "p", "CT", 3, True, 3, 900, 5000, 0)
    labels = labels_for_moment(moment, demo)
    assert "4K" in labels
    assert "spread" in labels
    assert "1v3" in labels


def test_clip_filename():
    rounds = [make_round(0, 0, 100000)]
    kills = [make_kill(1000 + i * 32, victim=str(i), weapon="ak47") for i in range(5)]
    demo = make_demo(kills, rounds)
    moment = cluster_moments(kills, TICKRATE)[0]
    moment.labels = labels_for_moment(moment, demo)
    name = clip_filename(3, moment, "de_mirage")
    assert name.startswith("03_")
    assert "ACE" in name
    assert "mirage" in name
    assert name.endswith("_r1.mp4")
