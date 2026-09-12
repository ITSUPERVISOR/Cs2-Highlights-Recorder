"""Tests for unattended recording command plan and window helpers."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

from reel_core.config import RecordingConfig
from reel_core.demo.parser import DemoData
from reel_core.models import CameraAction, Sequence
from reel_core.recording.sequences import UNATTENDED_COMMANDS, build_actions_file
from reel_core.recording.win32_window import prepare_unattended_game_window, sink_window


def _demo(path: Path) -> DemoData:
    return DemoData(
        path=path,
        map_name="de_dust2",
        tickrate=64.0,
        kills=[],
        deaths=[],
        rounds=[],
        player_names={"76561198000000000": "Player"},
        slots={"76561198000000000": 1},
    )


def _sequence() -> Sequence:
    return Sequence(
        number=1,
        start_tick=1000,
        end_tick=1200,
        cameras=[CameraAction(tick=1000, steamid="76561198000000000")],
        label="2K",
        score=10.0,
        round_index=1,
    )


def test_unattended_actions_include_no_focus_commands(tmp_path: Path):
    demo_path = tmp_path / "match.dem"
    demo_path.write_bytes(b"")
    actions = build_actions_file(
        demo_path,
        [_sequence()],
        _demo(demo_path),
        RecordingConfig(unattended=True),
        tmp_path / "out",
    )
    text = actions.write().read_text(encoding="utf-8")
    for command in UNATTENDED_COMMANDS:
        assert command in text


def test_attended_actions_omit_no_focus_commands(tmp_path: Path):
    demo_path = tmp_path / "match.dem"
    demo_path.write_bytes(b"")
    actions = build_actions_file(
        demo_path,
        [_sequence()],
        _demo(demo_path),
        RecordingConfig(unattended=False),
        tmp_path / "out",
    )
    text = actions.write().read_text(encoding="utf-8")
    for command in UNATTENDED_COMMANDS:
        assert command not in text


def test_prepare_unattended_skips_non_windows():
    with patch("reel_core.recording.win32_window.sys") as fake_sys:
        fake_sys.platform = "linux"
        assert prepare_unattended_game_window(1234) is False


def test_sink_window_calls_set_window_pos():
    user32 = MagicMock()

    def get_work(_action, _ui, rect_ref, _f):
        r = rect_ref._obj
        r.left, r.top, r.right, r.bottom = 0, 0, 1920, 1080
        return 1

    def get_win(_hwnd, rect_ref):
        r = rect_ref._obj
        r.left, r.top, r.right, r.bottom = 10, 20, 810, 620
        return 1

    user32.SystemParametersInfoW.side_effect = get_work
    user32.GetWindowRect.side_effect = get_win
    user32.SetWindowPos.return_value = 1

    with patch("reel_core.recording.win32_window._user32", return_value=user32):
        assert sink_window(42) is True

    user32.SetWindowPos.assert_called_once()
    args = user32.SetWindowPos.call_args[0]
    assert args[0] == 42
    assert args[1] == 1  # HWND_BOTTOM
    assert args[2] == 1920 - 800
    assert args[3] == 1080 - 600
