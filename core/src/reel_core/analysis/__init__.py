from reel_core.analysis.clutch import attach_clutches, detect_clutches
from reel_core.analysis.labels import apply_labels
from reel_core.analysis.moments import cluster_moments
from reel_core.analysis.scoring import score_moments
from reel_core.analysis.selection import select_sequences
from reel_core.analysis.stats import compute_player_stats
from reel_core.config import Config
from reel_core.demo.parser import DemoData
from reel_core.models import Sequence


def analyze(
    demo: DemoData,
    config: Config,
    player_steamid: str | None = None,
) -> tuple[list, list[Sequence], dict]:
    moments = cluster_moments(demo.kills, demo.tickrate, config.selection.kill_gap_seconds)
    clutches = detect_clutches(demo)
    moments = attach_clutches(moments, clutches, demo)
    score_moments(moments, demo)
    apply_labels(moments, demo)
    sequences = select_sequences(moments, demo, config.selection, config.recording, player_steamid)
    stats = compute_player_stats(demo, clutches)
    if player_steamid:
        moments = [m for m in moments if m.steamid == player_steamid]
    return moments, sequences, stats
