"""Local CS2 map meshes for Preview. Never ships Valve files in the repo.

Preview uses the map's *collision* hull (``world_physics.vmdl_c``), not the render
geometry. The render mesh carries every prop fragment plus materials — Inferno
exports to ~800 MB, which WebGL cannot load. The collision hull is untextured
blocky brushwork, which is what a pose replay needs anyway.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from reel_core.config import app_data_dir
from reel_core.recording import steam, toolchain

EXPORT_KIND = "collision"
EXPORT_VERSION = 2
MARKER_NAME = "export.json"

MIN_MESH_BYTES = 1024
# Hard ceiling so an oversized export can never be handed to the renderer again.
MAX_MESH_BYTES = 400 * 1024 * 1024


def maps_cache_dir() -> Path:
    path = app_data_dir() / "maps"
    path.mkdir(parents=True, exist_ok=True)
    return path


def find_source2viewer() -> Path | None:
    return toolchain.find_source2viewer()


def find_map_vpk(map_name: str) -> Path | None:
    folder = steam.get_cs2_folder()
    if folder is None:
        return None
    stem = Path(map_name).name
    candidates = [
        folder / "game" / "csgo" / "maps" / f"{stem}.vpk",
        folder / "csgo" / "maps" / f"{stem}.vpk",
    ]
    for path in candidates:
        if path.is_file():
            return path
    return None


def _gameinfo() -> Path | None:
    folder = steam.get_cs2_folder()
    if folder is None:
        return None
    path = folder / "game" / "csgo" / "gameinfo.gi"
    return path if path.is_file() else None


def write_fallback_gltf(map_name: str, frames: list[dict] | None = None) -> Path:
    """Unit-correct ground plane around the clip AABB (CS2 inches, Z-up baked to Y-up)."""
    xs: list[float] = []
    ys: list[float] = []
    zs: list[float] = []
    for frame in frames or []:
        for pose in frame.get("players", {}).values():
            xs.append(float(pose.get("x", 0)))
            ys.append(float(pose.get("y", 0)))
            zs.append(float(pose.get("z", 0)))
    if not xs:
        xs, ys, zs = [0.0], [0.0], [0.0]
    pad = 800.0
    min_x, max_x = min(xs) - pad, max(xs) + pad
    min_y, max_y = min(ys) - pad, max(ys) + pad
    ground_z = min(zs) - 8.0
    cx = (min_x + max_x) / 2
    cy = (min_y + max_y) / 2
    hx = (max_x - min_x) / 2
    hz = (max_y - min_y) / 2
    dest = maps_cache_dir() / f"{Path(map_name).name or 'map'}-fallback.gltf"
    gltf = {
        "asset": {"version": "2.0", "generator": "cs2-reel-fallback"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "translation": [cx, ground_z, -cy]}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1, "mode": 4}]}],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5126,
                "count": 4,
                "type": "VEC3",
                "min": [-hx, 0, -hz],
                "max": [hx, 0, hz],
            },
            {"bufferView": 1, "componentType": 5123, "count": 6, "type": "SCALAR"},
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": 48, "target": 34962},
            {"buffer": 0, "byteOffset": 48, "byteLength": 12, "target": 34963},
        ],
        "buffers": [{"uri": dest.with_suffix(".bin").name, "byteLength": 60}],
    }
    import struct

    verts = struct.pack("<12f", -hx, 0, hz, hx, 0, hz, hx, 0, -hz, -hx, 0, -hz)
    idx = struct.pack("<6H", 0, 1, 2, 0, 2, 3)
    dest.with_suffix(".bin").write_bytes(verts + idx)
    dest.write_text(json.dumps(gltf), encoding="utf-8")
    return dest


def _cli_stamp(cli: Path | None) -> str:
    """Identity for the exporter binary, so a CLI upgrade invalidates the cache."""
    if cli is None:
        return "none"
    try:
        stat = cli.stat()
    except OSError:
        return "unknown"
    return f"{stat.st_size}:{stat.st_mtime_ns}"


def _read_marker(dest_dir: Path) -> dict | None:
    path = dest_dir / MARKER_NAME
    if not path.is_file():
        return None
    try:
        marker = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return marker if isinstance(marker, dict) else None


def _write_marker(dest_dir: Path, mesh: Path, cli: Path | None) -> None:
    marker = {
        "kind": EXPORT_KIND,
        "version": EXPORT_VERSION,
        "cli": _cli_stamp(cli),
        "mesh": mesh.name,
    }
    (dest_dir / MARKER_NAME).write_text(json.dumps(marker), encoding="utf-8")


def _marker_is_current(marker: dict | None) -> bool:
    if not marker:
        return False
    return marker.get("kind") == EXPORT_KIND and marker.get("version") == EXPORT_VERSION


def _find_mesh(dest_dir: Path) -> Path | None:
    """Newest usable mesh in the cache dir, preferring the dedicated physics export."""
    if not dest_dir.is_dir():
        return None
    found = list(dest_dir.rglob("*.glb")) + list(dest_dir.rglob("*.gltf"))
    usable: list[Path] = []
    for path in found:
        try:
            size = path.stat().st_size
        except OSError:
            continue
        if MIN_MESH_BYTES < size <= MAX_MESH_BYTES:
            usable.append(path)
    if not usable:
        return None
    physics = [path for path in usable if path.stem.endswith("_physics")]
    pool = physics or usable
    glb = [path for path in pool if path.suffix.lower() == ".glb"]
    return (glb or pool)[0]


def _cached_world(dest_dir: Path) -> Path | None:
    """Cached mesh, but only when it came from the current collision export."""
    if not _marker_is_current(_read_marker(dest_dir)):
        return None
    return _find_mesh(dest_dir)


def _clear_stale(dest_dir: Path) -> None:
    """Drop meshes left by an older export kind (e.g. the 800 MB render geometry)."""
    if not dest_dir.is_dir():
        return
    for path in list(dest_dir.rglob("*.glb")) + list(dest_dir.rglob("*.gltf")):
        try:
            path.unlink()
        except OSError:
            continue
    for path in dest_dir.rglob("*.bin"):
        try:
            path.unlink()
        except OSError:
            continue


def _try_source2viewer(map_vpk: Path, dest_dir: Path) -> Path | None:
    cli = find_source2viewer()
    if cli is None:
        try:
            cli = toolchain.install_source2viewer()
        except Exception:
            return None
    dest_dir.mkdir(parents=True, exist_ok=True)
    cached = _cached_world(dest_dir)
    if cached is not None:
        return cached

    _clear_stale(dest_dir)

    stem = map_vpk.stem
    out_glb = dest_dir / f"{stem}.glb"
    folder = str(dest_dir) + os.sep
    game = _gameinfo()
    # No --gltf_export_materials: the collision hull is meant to be untextured.
    base = [str(cli), "-i", str(map_vpk), "-d", "--gltf_export_format", "glb"]
    if game is not None:
        base.extend(["--game", str(game)])
    attempts = [
        [*base, "-o", str(out_glb), "-f", f"maps/{stem}/world_physics.vmdl_c"],
        [*base, "-o", folder, "-f", f"maps/{stem}/world_physics"],
    ]
    for args in attempts:
        try:
            subprocess.run(
                args,
                capture_output=True,
                text=True,
                timeout=480,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
            )
        except (OSError, subprocess.TimeoutExpired):
            continue
        found = _find_mesh(dest_dir)
        if found is not None:
            _write_marker(dest_dir, found, cli)
            return found
    return None


def resolve_map_gltf(
    map_name: str,
    frames: list[dict] | None = None,
    *,
    export: bool = False,
) -> tuple[Path | None, str]:
    """Return ``(mesh, kind)`` where kind is ``collision`` or ``fallback``."""
    stem = Path(map_name).name or "unknown"
    dest_dir = maps_cache_dir() / stem
    existing = _cached_world(dest_dir)
    if existing is not None:
        return existing, EXPORT_KIND

    if export:
        vpk = find_map_vpk(stem)
        if vpk is not None:
            exported = _try_source2viewer(vpk, dest_dir)
            if exported is not None:
                return exported, EXPORT_KIND

    fallback = write_fallback_gltf(stem, frames)
    return fallback, "fallback"


def export_map_gltf(map_name: str, frames: list[dict] | None = None) -> tuple[Path | None, str]:
    """Install Source2Viewer if needed and export the local CS2 collision mesh."""
    return resolve_map_gltf(map_name, frames, export=True)
