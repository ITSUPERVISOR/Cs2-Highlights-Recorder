from pathlib import Path
from unittest.mock import patch

import pytest

from reel_core.recording.plugin import gameinfo_status, install_plugin, uninstall_plugin
from reel_core.recording.recorder import RecordingSetupError

GAMEINFO = """"GameInfo"
{
	FileSystem
	{
		SearchPaths
		{
			Game	csgo
			Game	csgo_core
		}
	}
}
"""


def _fake_cs2(tmp_path: Path) -> tuple[Path, Path]:
    cs2 = tmp_path / "cs2"
    gi = cs2 / "game" / "csgo" / "gameinfo.gi"
    gi.parent.mkdir(parents=True)
    gi.write_text(GAMEINFO, encoding="utf-8")
    (cs2 / "game" / "bin" / "win64").mkdir(parents=True)
    dll = tmp_path / "server.dll"
    dll.write_bytes(b"dll")
    return cs2, dll


def test_install_patches_gameinfo(tmp_path: Path):
    cs2, dll = _fake_cs2(tmp_path)
    with patch("reel_core.recording.plugin.is_process_running", return_value=False):
        install_plugin(cs2, dll)
    text = (cs2 / "game" / "csgo" / "gameinfo.gi").read_text(encoding="utf-8")
    assert "Game\tcsgo/csdm" in text
    assert (cs2 / "game" / "csgo" / "csdm" / "bin" / "server.dll").is_file()
    uninstall_plugin(cs2)
    restored = (cs2 / "game" / "csgo" / "gameinfo.gi").read_text(encoding="utf-8")
    assert "Game\tcsgo/csdm" not in restored


def test_install_clears_readonly(tmp_path: Path):
    cs2, dll = _fake_cs2(tmp_path)
    gi = cs2 / "game" / "csgo" / "gameinfo.gi"
    gi.chmod(0o444)
    with patch("reel_core.recording.plugin.is_process_running", return_value=False):
        install_plugin(cs2, dll)
    assert "Game\tcsgo/csdm" in gi.read_text(encoding="utf-8")


def test_install_refuses_when_cs2_running(tmp_path: Path):
    cs2, dll = _fake_cs2(tmp_path)
    with patch("reel_core.recording.plugin.is_process_running", return_value=True):
        with pytest.raises(RecordingSetupError, match="CS2 is still running"):
            install_plugin(cs2, dll)


def test_install_permission_error_is_setup_error(tmp_path: Path):
    cs2, dll = _fake_cs2(tmp_path)
    with (
        patch("reel_core.recording.plugin.is_process_running", return_value=False),
        patch("pathlib.Path.write_text", side_effect=PermissionError("denied")),
        pytest.raises(RecordingSetupError, match="Cannot write"),
    ):
        install_plugin(cs2, dll)


def test_gameinfo_status_ok(tmp_path: Path):
    cs2, _ = _fake_cs2(tmp_path)
    with patch("reel_core.recording.plugin.is_process_running", return_value=False):
        ok, detail, hint = gameinfo_status(cs2)
    assert ok is True
    assert "gameinfo.gi" in detail
    assert hint == ""


def test_gameinfo_status_when_cs2_running(tmp_path: Path):
    cs2, _ = _fake_cs2(tmp_path)
    with patch("reel_core.recording.plugin.is_process_running", return_value=True):
        ok, detail, hint = gameinfo_status(cs2)
    assert ok is False
    assert "running" in detail.lower()
    assert "Close CS2" in hint
