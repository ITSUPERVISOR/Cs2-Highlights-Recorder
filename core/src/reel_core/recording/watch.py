"""Launch CS2 at a tick without HLAE, plus console commands for OBS fallback."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from reel_core.recording.actions_file import MIN_SAFE_TICK
from reel_core.recording.steam import get_cs2_folder, get_csgo_dir, get_steam_exe
from reel_core.steamids import account_id
from reel_core.util.process import is_process_running

WATCH_CFG = "reel_watch.cfg"


def demo_play_name(demo_path: Path, cs2_folder: Path | None) -> str:
    """Relative name CS2's playdemo command can resolve."""
    if cs2_folder is None:
        return demo_path.stem
    csgo = get_csgo_dir(cs2_folder)
    try:
        rel = demo_path.resolve().relative_to(csgo.resolve())
        return rel.with_suffix("").as_posix()
    except ValueError:
        return demo_path.stem


def stage_demo(demo_path: Path, cs2_folder: Path) -> Path:
    csgo = get_csgo_dir(cs2_folder)
    try:
        demo_path.resolve().relative_to(csgo.resolve())
        return demo_path
    except ValueError:
        pass
    target = csgo / demo_path.name
    if not target.exists() or target.stat().st_mtime < demo_path.stat().st_mtime:
        shutil.copy2(demo_path, target)
    return target


def playdemo_command(name: str, tick: int) -> str:
    """Single command: CS2 ignores a separate +demo_gototick issued before the demo loads."""
    return f"playdemo {name} {max(MIN_SAFE_TICK, int(tick))}"


def console_commands(demo_path: Path, tick: int, steamid: str | None, cs2_folder: Path | None) -> list[str]:
    name = demo_play_name(demo_path, cs2_folder)
    commands = [playdemo_command(name, tick)]
    if steamid:
        acc = account_id(steamid) or steamid
        commands.append(f"spec_player_by_accountid {acc}")
    return commands


def write_watch_cfg(cs2_folder: Path, commands: list[str]) -> Path | None:
    cfg_dir = get_csgo_dir(cs2_folder) / "cfg"
    try:
        cfg_dir.mkdir(parents=True, exist_ok=True)
        path = cfg_dir / WATCH_CFG
        path.write_text("\n".join(commands) + "\n", encoding="utf-8")
        return path
    except OSError:
        return None


def launch_watch(demo_path: Path, tick: int, steamid: str | None) -> dict:
    steam_exe = get_steam_exe()
    cs2_folder = get_cs2_folder()
    staged = demo_path
    if cs2_folder is not None:
        staged = stage_demo(demo_path, cs2_folder)
    commands = console_commands(staged, tick, steamid, cs2_folder)
    launched = False
    error = None
    hint = "If CS2 is already open, paste the commands into the console (~)."

    already_running = is_process_running("cs2.exe")
    if already_running:
        hint = "CS2 is already open, so launch options were ignored. Press ~ and paste the copied commands."
    elif steam_exe is not None:
        args = [str(steam_exe), "-applaunch", "730", "-insecure"]
        cfg = write_watch_cfg(cs2_folder, commands) if cs2_folder is not None else None
        if cfg is not None:
            args += ["+exec", "reel_watch"]
        else:
            name = demo_play_name(staged, cs2_folder)
            args += ["+playdemo", f"{name} {max(MIN_SAFE_TICK, int(tick))}"]
            if steamid:
                args += ["+spec_player_by_accountid", account_id(steamid) or steamid]
        try:
            subprocess.Popen(args)
            launched = True
        except OSError as exc:
            error = str(exc)
    else:
        error = "steam.exe not found"

    return {
        "launched": launched,
        "commands": commands,
        "copyText": "; ".join(commands),
        "demoPath": str(staged),
        "tick": max(MIN_SAFE_TICK, int(tick)),
        "error": error,
        "hint": hint,
    }
