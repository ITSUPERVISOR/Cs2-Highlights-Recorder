"""TOML config in ~/.cs2-reel — not AppData (Store Python virtualizes it)."""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field, fields
from pathlib import Path
import os

APP_NAME = "cs2-reel"


def app_data_dir() -> Path:
    override = os.environ.get("CS2_REEL_HOME")
    if override:
        return Path(override)
    local = os.environ.get("LOCALAPPDATA")
    if local:
        return Path(local) / "cs2-reel"
    return Path.home() / f".{APP_NAME}"


def config_file_path() -> Path:
    return app_data_dir() / "config.toml"


@dataclass
class PathsConfig:
    cs2_exe: str = "auto"
    hlae_dir: str = "auto"
    ffmpeg_exe: str = "auto"
    plugin_dll: str = "auto"
    work_dir: str = "auto"
    steam_id: str = "auto"


@dataclass
class RecordingConfig:
    fps: int = 60
    width: int = 1920
    height: int = 1080
    crf: int = 23
    lead_in_seconds: float = 4.0
    lead_out_seconds: float = 3.0
    death_notices_duration: int = 5
    clean_hud: bool = True
    # Keep CS2 visible but backgrounded; do not minimize (MIRV black frames).
    # Set false to require a focused CS2 window during Record.
    unattended: bool = True


@dataclass
class SelectionConfig:
    top: int = 10
    max_duration: float = 0.0
    min_kills: int = 2
    kill_gap_seconds: float = 20.0
    merge_gap_seconds: float = 5.0


@dataclass
class Config:
    paths: PathsConfig = field(default_factory=PathsConfig)
    recording: RecordingConfig = field(default_factory=RecordingConfig)
    selection: SelectionConfig = field(default_factory=SelectionConfig)


def _apply_section(section_obj: object, data: dict) -> None:
    valid = {f.name for f in fields(section_obj)}  # type: ignore[arg-type]
    for key, value in data.items():
        if key in valid:
            setattr(section_obj, key, value)


def load_config(path: Path | None = None) -> Config:
    config = Config()
    file_path = path or config_file_path()
    if file_path.is_file():
        data = tomllib.loads(file_path.read_text(encoding="utf-8"))
        for section_name in ("paths", "recording", "selection"):
            if isinstance(data.get(section_name), dict):
                _apply_section(getattr(config, section_name), data[section_name])
    return config
