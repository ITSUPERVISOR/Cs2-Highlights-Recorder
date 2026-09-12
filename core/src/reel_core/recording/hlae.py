"""Launch CS2 through HLAE's custom loader."""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path

from reel_core.config import app_data_dir
from reel_core.recording.sequences import to_unix_path
from reel_core.util.log import info
from reel_core.util.process import kill_processes, wait_for_process_exit, wait_for_process_start

GAME_PROCESS = "cs2.exe"

CRASH_ADVICE = (
    "The game crashed during startup. The usual cause is HLAE lagging a CS2 patch. "
    "Run `reel-core update-tools` once advancedfx ships a new release: "
    "https://github.com/advancedfx/advancedfx/releases"
)


class HlaeError(RuntimeError):
    pass


class GameError(RuntimeError):
    pass


def find_minidumps_since(cs2_exe: Path, since_timestamp: float) -> list[Path]:
    dumps = []
    for dump in cs2_exe.parent.glob("*.mdmp"):
        try:
            if dump.stat().st_mtime >= since_timestamp:
                dumps.append(dump)
        except OSError:
            continue
    return dumps


def build_hlae_args(
    hlae_exe: Path,
    cs2_exe: Path,
    demo_path: Path,
    width: int,
    height: int,
) -> list[str]:
    game_args = (
        f'-insecure -novid +playdemo "{to_unix_path(demo_path)}"'
        f" -width {width} -height {height} -sw"
    )
    return [
        str(hlae_exe),
        "-noGui",
        "-autoStart",
        "-noConfig",
        "-afxDisableSteamStorage",
        "-customLoader",
        "-hookDllPath",
        str(hlae_exe.parent / "x64" / "AfxHookSource2.dll"),
        "-programPath",
        str(cs2_exe),
        "-cmdLine",
        game_args,
    ]


def _hlae_error_window_exists() -> bool:
    result = subprocess.run(
        ["tasklist", "/fi", f"imagename eq {GAME_PROCESS}", "/v", "/nh"],
        capture_output=True,
        text=True,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    return "Error - AfxHookSource" in (result.stdout or "")


def run_game_with_hlae(
    hlae_exe: Path,
    cs2_exe: Path,
    demo_path: Path,
    width: int,
    height: int,
    timeout_seconds: float,
    unattended: bool = True,
) -> None:
    if kill_processes(GAME_PROCESS):
        info("Killed a running CS2 instance, waiting for file locks to release...")
        time.sleep(2)

    cfg_sandbox = app_data_dir() / "cs2-cfg"
    cfg_sandbox.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, USRLOCALCSGO=str(cfg_sandbox))

    launch_time = time.time()
    args = build_hlae_args(hlae_exe, cs2_exe, demo_path, width, height)
    result = subprocess.run(args, capture_output=True, text=True, env=env)
    if result.returncode != 0:
        raise HlaeError(
            f"HLAE exited with code {result.returncode}: {result.stderr or result.stdout}"
        )

    time.sleep(2)
    if _hlae_error_window_exists():
        raise HlaeError("HLAE injection failed (Error - AfxHookSource window detected)")

    def crash_suffix() -> str:
        dumps = find_minidumps_since(cs2_exe, launch_time)
        return f"\n{CRASH_ADVICE}\nMinidump: {dumps[-1]}" if dumps else ""

    game = wait_for_process_start(GAME_PROCESS, timeout=30)
    if game is None:
        raise GameError(f"CS2 did not start (or crashed immediately).{crash_suffix()}")

    if unattended:
        from reel_core.recording.win32_window import prepare_unattended_game_window

        # Sink behind other windows but keep fully visible — never minimize/hide.
        prepare_unattended_game_window(game.pid)
        info(
            "CS2 is recording in unattended mode (window kept visible in the background; "
            "do not minimize). Still roughly realtime."
        )
    else:
        info("CS2 is running — keep the game focused until it quits (roughly realtime)...")

    if not wait_for_process_exit(game, timeout=timeout_seconds):
        kill_processes(GAME_PROCESS)
        raise GameError(
            f"Recording did not finish within {int(timeout_seconds)}s watchdog — killed CS2"
        )

    dumps = find_minidumps_since(cs2_exe, launch_time)
    if dumps:
        raise GameError(f"CS2 crashed during recording.{crash_suffix()}")
