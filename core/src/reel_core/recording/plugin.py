"""Install/uninstall the CS2 server plugin. Always restore gameinfo.gi."""

from __future__ import annotations

import os
import shutil
import stat
from pathlib import Path

from reel_core.recording.steam import get_gameinfo_path
from reel_core.util.process import is_process_running

GAMEINFO_ORIGINAL = "Game\tcsgo"
GAMEINFO_PATCHED = "Game\tcsgo/csdm\n\t\t\tGame\tcsgo"
CS2_PROCESS = "cs2.exe"

WRITE_HINT = (
    "Close CS2 fully, uncheck Read-only on that file if it is set, "
    "and confirm this Windows account can write the Steam library."
)


def _setup_error(message: str) -> None:
    from reel_core.recording.recorder import RecordingSetupError

    raise RecordingSetupError(message)


def _plugin_folder(cs2_folder: Path) -> Path:
    return cs2_folder / "game" / "csgo" / "csdm"


def _backup_path(gameinfo: Path) -> Path:
    return gameinfo.with_name(gameinfo.name + ".cs2reel.bak")


def _log_file(cs2_folder: Path) -> Path:
    return cs2_folder / "game" / "bin" / "win64" / "csdm.log"


def _clear_readonly(path: Path) -> None:
    try:
        mode = path.stat().st_mode
        if not mode & stat.S_IWRITE:
            path.chmod(mode | stat.S_IWRITE)
        attrs = getattr(path.stat(), "st_file_attributes", 0)
        readonly = getattr(stat, "FILE_ATTRIBUTE_READONLY", 0x1)
        if os.name == "nt" and attrs & readonly:
            os.chmod(path, stat.S_IWRITE)
    except OSError:
        return


def gameinfo_status(cs2_folder: Path) -> tuple[bool, str, str]:
    """Doctor check: (ok, detail, hint) for writing gameinfo.gi."""
    gameinfo = get_gameinfo_path(cs2_folder)
    if not gameinfo.is_file():
        return False, f"missing: {gameinfo}", "CS2 install looks incomplete"
    if is_process_running(CS2_PROCESS):
        return False, f"CS2 is running; it locks {gameinfo}", "Close CS2 fully before recording"
    try:
        _clear_readonly(gameinfo)
        with gameinfo.open("r+", encoding="utf-8") as handle:
            handle.read(1)
        return True, str(gameinfo), ""
    except OSError as exc:
        return False, f"not writable: {gameinfo} ({exc})", WRITE_HINT


def install_plugin(cs2_folder: Path, plugin_dll: Path) -> None:
    if is_process_running(CS2_PROCESS):
        _setup_error("CS2 is still running. Close it fully before recording so Reel can patch gameinfo.gi.")

    try:
        bin_folder = _plugin_folder(cs2_folder) / "bin"
        bin_folder.mkdir(parents=True, exist_ok=True)
        _log_file(cs2_folder).unlink(missing_ok=True)
        shutil.copyfile(plugin_dll, bin_folder / "server.dll")

        gameinfo = get_gameinfo_path(cs2_folder)
        _clear_readonly(gameinfo)
        content = gameinfo.read_text(encoding="utf-8")
        if "Game\tcsgo/csdm" not in content:
            shutil.copyfile(gameinfo, _backup_path(gameinfo))
            _clear_readonly(gameinfo)
            gameinfo.write_text(content.replace(GAMEINFO_ORIGINAL, GAMEINFO_PATCHED, 1), encoding="utf-8")
    except OSError as exc:
        gameinfo = get_gameinfo_path(cs2_folder)
        _setup_error(f"Cannot write {gameinfo}: {exc}. {WRITE_HINT}")


def uninstall_plugin(cs2_folder: Path) -> None:
    folder = _plugin_folder(cs2_folder)
    if folder.exists():
        shutil.rmtree(folder, ignore_errors=True)

    gameinfo = get_gameinfo_path(cs2_folder)
    backup = _backup_path(gameinfo)
    try:
        _clear_readonly(gameinfo)
        if backup.is_file():
            shutil.copyfile(backup, gameinfo)
            backup.unlink(missing_ok=True)
        elif gameinfo.is_file():
            content = gameinfo.read_text(encoding="utf-8")
            if "Game\tcsgo/csdm" in content:
                restored = content.replace("Game\tcsgo/csdm\n\t\t\tGame\tcsgo", GAMEINFO_ORIGINAL, 1)
                gameinfo.write_text(restored, encoding="utf-8")
    except OSError:
        return
