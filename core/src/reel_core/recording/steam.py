from __future__ import annotations

import winreg
from dataclasses import dataclass
from pathlib import Path

import vdf

from reel_core.steamids import canonicalize_steamid, pick_login_steamid
from reel_core.util.process import is_process_running

CS_APP_ID = "730"
CS_FOLDER_NAME = "Counter-Strike Global Offensive"


def get_steam_folder() -> Path | None:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as key:
            value, _ = winreg.QueryValueEx(key, "SteamPath")
    except OSError:
        return None
    if not value:
        return None
    return Path(str(value))


def get_steam_exe() -> Path | None:
    folder = get_steam_folder()
    if folder is None:
        return None
    exe = folder / "steam.exe"
    return exe if exe.is_file() else None


def get_cs2_folder() -> Path | None:
    steam = get_steam_folder()
    if steam is None:
        return None
    vdf_path = steam / "steamapps" / "libraryfolders.vdf"
    if not vdf_path.is_file():
        return None
    try:
        data = vdf.loads(vdf_path.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return None
    folders = data.get("libraryfolders", {})
    for entry in folders.values():
        if not isinstance(entry, dict):
            continue
        apps = entry.get("apps") or {}
        if CS_APP_ID not in apps:
            continue
        folder = Path(entry.get("path", "")) / "steamapps" / "common" / CS_FOLDER_NAME
        if folder.is_dir():
            return folder
    return None


def get_cs2_exe(cs2_folder: Path) -> Path:
    return cs2_folder / "game" / "bin" / "win64" / "cs2.exe"


def get_gameinfo_path(cs2_folder: Path) -> Path:
    return cs2_folder / "game" / "csgo" / "gameinfo.gi"


def get_csgo_dir(cs2_folder: Path) -> Path:
    return cs2_folder / "game" / "csgo"


def get_replays_dir(cs2_folder: Path) -> Path:
    return cs2_folder / "game" / "csgo" / "replays"


def cs2_folder_from_exe(cs2_exe: Path) -> Path:
    return cs2_exe.parent.parent.parent.parent


def read_steam_inf(cs2_folder: Path) -> dict[str, str]:
    inf_path = cs2_folder / "game" / "csgo" / "steam.inf"
    result: dict[str, str] = {}
    if not inf_path.is_file():
        return result
    for line in inf_path.read_text(encoding="utf-8", errors="replace").splitlines():
        if "=" in line:
            key, _, value = line.partition("=")
            result[key.strip()] = value.strip()
    return result


def is_steam_running() -> bool:
    return is_process_running("steam.exe")


@dataclass(frozen=True)
class SteamAccount:
    steamid: str
    account_name: str
    persona_name: str
    most_recent: bool
    timestamp: int


def _loginusers() -> dict:
    steam = get_steam_folder()
    if steam is None:
        return {}
    path = steam / "config" / "loginusers.vdf"
    if not path.is_file():
        return {}
    try:
        data = vdf.loads(path.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return {}
    users = data.get("users") or {}
    return users if isinstance(users, dict) else {}


def list_steam_accounts() -> list[SteamAccount]:
    """Steam accounts that have logged in on this PC, most-recent first."""
    accounts: list[SteamAccount] = []
    for steamid, info in _loginusers().items():
        if not isinstance(info, dict):
            continue
        canonical = canonicalize_steamid(steamid)
        if not canonical:
            continue
        try:
            timestamp = int(info.get("Timestamp") or 0)
        except (TypeError, ValueError):
            timestamp = 0
        accounts.append(
            SteamAccount(
                steamid=canonical,
                account_name=str(info.get("AccountName") or ""),
                persona_name=str(info.get("PersonaName") or ""),
                most_recent=str(info.get("MostRecent", "0")) == "1",
                timestamp=timestamp,
            )
        )
    accounts.sort(key=lambda account: (account.most_recent, account.timestamp, account.steamid), reverse=True)
    return accounts


def detect_steamid64() -> str | None:
    """Most-recent Steam account from loginusers.vdf (MostRecent, else latest Timestamp)."""
    return pick_login_steamid(_loginusers())
