from pathlib import Path

from reel_core.recording.actions_file import MIN_SAFE_TICK, ActionsFile


def test_ticks_never_below_safe_minimum(tmp_path: Path):
    demo = tmp_path / "match.dem"
    demo.write_bytes(b"")
    actions = ActionsFile(demo)
    actions.add_exec(1, "sv_cheats 1")
    actions.add_go_to_tick(1, 40)
    actions.add_pause_playback(50)
    path = actions.write()
    text = path.read_text(encoding="utf-8")
    assert str(MIN_SAFE_TICK) in text
    assert '"tick": 1' not in text
    assert '"tick": 40' not in text
