from pathlib import Path

from reel_core.recording.watch import console_commands, playdemo_command, write_watch_cfg


def test_playdemo_includes_start_tick():
    assert playdemo_command("replays/match730_foo", 54948) == "playdemo replays/match730_foo 54948"
    assert playdemo_command("replays/match730_foo", 1) == "playdemo replays/match730_foo 96"


def test_console_commands_skip_separate_gototick(tmp_path: Path):
    cs2 = tmp_path / "game" / "csgo"
    demo = cs2 / "replays" / "match730_clip.dem"
    demo.parent.mkdir(parents=True)
    demo.write_bytes(b"")
    commands = console_commands(demo, 54948, "76561198855944675", tmp_path)
    assert commands[0] == "playdemo replays/match730_clip 54948"
    assert all("demo_gototick" not in cmd for cmd in commands)
    assert commands[1].startswith("spec_player_by_accountid ")


def test_write_watch_cfg(tmp_path: Path):
    (tmp_path / "game" / "csgo").mkdir(parents=True)
    path = write_watch_cfg(tmp_path, ["playdemo replays/foo 1000", "spec_player_by_accountid 1"])
    assert path is not None
    text = path.read_text(encoding="utf-8")
    assert "playdemo replays/foo 1000" in text
    assert path.name == "reel_watch.cfg"
