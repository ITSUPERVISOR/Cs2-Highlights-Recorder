"""Locate or auto-install HLAE, FFmpeg and the CS2 server plugin.

Plugin is fetched from the live CS Demo Manager GitHub tree
(static/cs2/server.dll), not carved out of the NSIS installer.
HLAE includes prereleases when they are the newest published build —
CS2 hook fixes often land there first.
"""

from __future__ import annotations

import json
import shutil
import zipfile
from pathlib import Path

import requests

from reel_core.config import Config, app_data_dir
from reel_core.util.log import info

HLAE_RELEASES_API = "https://api.github.com/repos/advancedfx/advancedfx/releases"
FFMPEG_DOWNLOAD_URL = (
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
)
CSDM_PLUGIN_URL = (
    "https://raw.githubusercontent.com/akiver/cs-demo-manager/main/static/cs2/server.dll"
)

VENDOR_PLUGIN_PATH = Path(__file__).resolve().parents[3] / "vendor" / "cs2-plugin" / "server.dll"
CACHED_PLUGIN_PATH = lambda: tools_dir() / "plugin" / "server.dll"
CSDM_INSTALL_PLUGIN_CANDIDATES = (
    Path.home() / "AppData" / "Local" / "Programs" / "CS Demo Manager" / "resources" / "static" / "cs2" / "server.dll",
    Path.home() / "AppData" / "Local" / "Programs" / "cs-demo-manager" / "resources" / "static" / "cs2" / "server.dll",
)


def tools_dir() -> Path:
    return app_data_dir() / "tools"


def _download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    headers = {"User-Agent": "cs2-reel"}
    with requests.get(url, stream=True, timeout=600, headers=headers) as response:
        response.raise_for_status()
        with open(dest, "wb") as fh:
            for chunk in response.iter_content(chunk_size=1 << 20):
                fh.write(chunk)


def find_hlae(config: Config) -> Path | None:
    if config.paths.hlae_dir != "auto":
        exe = Path(config.paths.hlae_dir) / "HLAE.exe"
        return exe if exe.is_file() else None
    exe = tools_dir() / "hlae" / "HLAE.exe"
    return exe if exe.is_file() else None


def _pick_hlae_release(releases: list[dict]) -> tuple[str, dict]:
    usable = [r for r in releases if not r.get("draft")]
    usable.sort(key=lambda r: r.get("published_at", ""), reverse=True)
    for release in usable:
        for asset in release.get("assets", []):
            name = asset.get("name", "")
            if name.lower().endswith(".zip") and "source" not in name.lower():
                return asset["browser_download_url"], {
                    "tag": release.get("tag_name", ""),
                    "published_at": release.get("published_at", ""),
                    "prerelease": bool(release.get("prerelease")),
                }
    raise RuntimeError("Could not find an HLAE release zip on GitHub")


def install_hlae() -> Path:
    info("Downloading HLAE from GitHub releases...")
    releases = requests.get(
        HLAE_RELEASES_API, timeout=60, headers={"User-Agent": "cs2-reel"}
    ).json()
    if not isinstance(releases, list):
        raise RuntimeError(f"Unexpected HLAE releases payload: {releases}")
    asset_url, release_info = _pick_hlae_release(releases)

    dest_dir = tools_dir() / "hlae"
    zip_path = tools_dir() / "hlae.zip"
    _download(asset_url, zip_path)
    if dest_dir.exists():
        shutil.rmtree(dest_dir)
    dest_dir.mkdir(parents=True)
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(dest_dir)
    zip_path.unlink()

    exe = dest_dir / "HLAE.exe"
    if not exe.is_file():
        candidates = list(dest_dir.glob("**/HLAE.exe"))
        if not candidates:
            raise RuntimeError(f"HLAE.exe not found after extracting to {dest_dir}")
        exe = candidates[0]
    (exe.parent / "install-info.json").write_text(json.dumps(release_info), encoding="utf-8")
    info(f"HLAE installed: {exe} ({release_info.get('tag', '?')})")
    return exe


def read_hlae_install_info(hlae_exe: Path) -> dict:
    info_path = hlae_exe.parent / "install-info.json"
    if not info_path.is_file():
        return {}
    try:
        return json.loads(info_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def find_ffmpeg(config: Config) -> Path | None:
    if config.paths.ffmpeg_exe != "auto":
        exe = Path(config.paths.ffmpeg_exe)
        return exe if exe.is_file() else None
    exe = tools_dir() / "ffmpeg" / "bin" / "ffmpeg.exe"
    if exe.is_file():
        return exe
    on_path = shutil.which("ffmpeg")
    return Path(on_path) if on_path else None


def install_ffmpeg() -> Path:
    info("Downloading FFmpeg (BtbN win64-gpl build)...")
    dest_dir = tools_dir() / "ffmpeg"
    zip_path = tools_dir() / "ffmpeg.zip"
    _download(FFMPEG_DOWNLOAD_URL, zip_path)
    if dest_dir.exists():
        shutil.rmtree(dest_dir)
    dest_dir.mkdir(parents=True)
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(dest_dir)
    zip_path.unlink()

    candidates = list(dest_dir.glob("**/bin/ffmpeg.exe"))
    if not candidates:
        raise RuntimeError(f"ffmpeg.exe not found after extracting to {dest_dir}")
    exe = candidates[0]
    normalized = dest_dir / "bin" / "ffmpeg.exe"
    if exe != normalized:
        normalized.parent.mkdir(parents=True, exist_ok=True)
        for sibling in exe.parent.iterdir():
            shutil.move(str(sibling), str(normalized.parent / sibling.name))
        release_root = exe.parent.parent
        if release_root != dest_dir:
            shutil.rmtree(release_root, ignore_errors=True)
    info(f"FFmpeg installed: {normalized}")
    return normalized


def find_plugin_dll(config: Config) -> Path | None:
    if config.paths.plugin_dll != "auto":
        dll = Path(config.paths.plugin_dll)
        return dll if dll.is_file() else None
    cached = CACHED_PLUGIN_PATH()
    if cached.is_file():
        return cached
    if VENDOR_PLUGIN_PATH.is_file():
        return VENDOR_PLUGIN_PATH
    for candidate in CSDM_INSTALL_PLUGIN_CANDIDATES:
        if candidate.is_file():
            return candidate
    return None


def install_plugin_dll() -> Path:
    """Download server.dll from the current CSDM GitHub tree."""
    dest = CACHED_PLUGIN_PATH()
    dest.parent.mkdir(parents=True, exist_ok=True)
    info("Downloading CS Demo Manager CS2 plugin (server.dll)...")
    _download(CSDM_PLUGIN_URL, dest)
    if dest.stat().st_size < 10_000:
        dest.unlink(missing_ok=True)
        raise RuntimeError("Downloaded plugin looks too small — GitHub may have served an HTML error page")
    notice = dest.parent / "NOTICE"
    if not notice.is_file():
        notice.write_text(
            "server.dll is the CS2 server plugin from CS Demo Manager\n"
            "https://github.com/akiver/cs-demo-manager (MIT License).\n"
            "Downloaded from static/cs2/server.dll on the current main branch.\n",
            encoding="utf-8",
        )
    info(f"Plugin installed: {dest}")
    return dest


def write_ffmpeg_ini(hlae_exe: Path, ffmpeg_exe: Path) -> None:
    ini_dir = hlae_exe.parent / "ffmpeg"
    ini_dir.mkdir(parents=True, exist_ok=True)
    (ini_dir / "ffmpeg.ini").write_text(f"[Ffmpeg]\nPath={ffmpeg_exe}", encoding="utf-8")
