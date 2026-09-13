"""Local CS2 map meshes for Preview. Never ships Valve files in the repo.

Preview uses the map's *collision* hull (``world_physics.vmdl_c``), not the render
geometry. The render mesh carries every prop fragment plus materials — Inferno
exports to ~800 MB, which freezes the host and which WebGL cannot load. High
quality therefore shares Medium's radar-tinted hull instead of exporting world64.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

from reel_core.config import app_data_dir
from reel_core.recording import steam, toolchain

EXPORT_KIND = "collision"
EXPORT_VERSION = 2
RADAR_KIND = "radar"
RADAR_VERSION = 1
WORLD64_KIND = "world64"
WORLD64_VERSION = 1
WORLD64_TEX_SIZE = 64
MARKER_NAME = "export.json"
OVERVIEW_NAME = "overview.json"
MISSING_KIND = "missing"
VALID_QUALITIES = ("low", "medium", "high")

MIN_MESH_BYTES = 1024
# Hard ceiling so an oversized export can never be handed to the renderer again.
MAX_MESH_BYTES = 400 * 1024 * 1024
# World64 is the same spirit, tighter after dropping props and 64px albedos.
MAX_WORLD64_BYTES = 200 * 1024 * 1024

PROP_NAME_TOKENS = (
    "prop_",
    "propstatic",
    "propragdoll",
    "entities",
    "clutter",
    "chicken",
    "hostage",
    "planted_c4",
    "light_omni",
    "light_spot",
    "env_",
    "particle",
    "sprite",
    "info_particle",
)

# Demo headers and library rows sometimes drop the official prefix
# (`dust2` instead of `de_dust2`). Cache keys and VPK lookup share this table.
MAP_ALIASES = {
    "dust2": "de_dust2",
    "dustii": "de_dust2",
    "dust": "de_dust2",
    "inferno": "de_inferno",
    "mirage": "de_mirage",
    "nuke": "de_nuke",
    "ancient": "de_ancient",
    "anubis": "de_anubis",
    "cache": "de_cache",
    "overpass": "de_overpass",
    "vertigo": "de_vertigo",
    "train": "de_train",
    "office": "cs_office",
    "italy": "cs_italy",
    "agency": "cs_agency",
    "militia": "cs_militia",
    "assault": "cs_assault",
    "baggage": "ar_baggage",
    "shoots": "ar_shoots",
    "poolday": "ar_pool_day",
    "pool_day": "ar_pool_day",
    "boulder": "de_boulder",
    "fachwerk": "de_fachwerk",
    "shelter": "de_shelter",
    "debris": "de_debris",
    "eldorado": "de_eldorado",
    "el_dorado": "de_eldorado",
}

MAP_PREFIXES = ("de_", "cs_", "ar_", "gd_")
# Workshop extras and lighting dumps live next to playable VPKs.
_SKIP_MAP_TOKENS = ("_vanity", "_preview", "_cameras", "graphics", "lightmap", "sound")


def maps_cache_dir() -> Path:
    path = app_data_dir() / "maps"
    path.mkdir(parents=True, exist_ok=True)
    return path


def find_source2viewer() -> Path | None:
    return toolchain.find_source2viewer()


def map_stem(map_name: str) -> str:
    """Bare lowercase stem: `de_dust2.vpk` and `maps/de_dust2` both become `de_dust2`."""
    raw = Path(str(map_name or "")).name
    stem = raw.lower().removesuffix(".vpk").strip().replace(" ", "_")
    return stem or "unknown"


def canonical_map_stem(map_name: str) -> str:
    stem = map_stem(map_name)
    return MAP_ALIASES.get(stem, stem)


def _map_dirs() -> list[Path]:
    folder = steam.get_cs2_folder()
    if folder is None:
        return []
    return [folder / "game" / "csgo" / "maps", folder / "csgo" / "maps"]


def _skip_map_vpk(stem: str) -> bool:
    if stem.endswith("_dir"):
        return True
    return any(token in stem for token in _SKIP_MAP_TOKENS)


def list_installed_maps() -> list[str]:
    """Playable map VPK stems in the local CS2 install, sorted."""
    found: set[str] = set()
    for directory in _map_dirs():
        if not directory.is_dir():
            continue
        for path in directory.glob("*.vpk"):
            stem = path.stem.lower()
            if _skip_map_vpk(stem):
                continue
            found.add(stem)
    return sorted(found)


def resolve_map_stem(map_name: str, installed: list[str] | None = None) -> str:
    """Alias + prefix match against the install so `dust2` finds `de_dust2.vpk`."""
    stem = canonical_map_stem(map_name)
    pool = list(installed) if installed is not None else list_installed_maps()
    present = set(pool)
    if stem in present:
        return stem
    if stem != "unknown":
        for prefix in MAP_PREFIXES:
            candidate = stem if stem.startswith(prefix) else f"{prefix}{stem}"
            if candidate in present:
                return candidate
        matches = [name for name in pool if name == stem or name.endswith(f"_{stem}") or name.endswith(stem)]
        if len(matches) == 1:
            return matches[0]
    return stem


def find_map_vpk(map_name: str) -> Path | None:
    stem = resolve_map_stem(map_name)
    for directory in _map_dirs():
        path = directory / f"{stem}.vpk"
        if path.is_file():
            return path
    return None


def map_is_installed(map_name: str) -> bool:
    return find_map_vpk(map_name) is not None


def normalize_quality(quality: str | None) -> str:
    value = str(quality or "low").strip().lower()
    return value if value in VALID_QUALITIES else "low"


def parse_overview_txt(text: str) -> dict | None:
    """CS overview convention: ``pos_x``/``pos_y`` are the NW corner, ``scale`` is units/pixel."""
    if not text:
        return None
    kv: dict[str, str] = {}
    for match in re.finditer(r'"([^"]+)"\s+"([^"]*)"', text):
        kv[match.group(1).strip().lower()] = match.group(2).strip()
    try:
        pos_x = float(kv["pos_x"])
        pos_y = float(kv["pos_y"])
        scale = float(kv["scale"])
    except (KeyError, ValueError):
        return None
    if scale == 0:
        return None
    altitude_split: float | None = None
    lower = re.search(r'"lower"\s*\{[^}]*"AltitudeMin"\s*"\s*([^"]+)"', text, re.I | re.S)
    if lower:
        try:
            altitude_split = float(lower.group(1).strip())
        except ValueError:
            altitude_split = None
    rotate = 0.0
    if "rotate" in kv:
        try:
            rotate = float(kv["rotate"])
        except ValueError:
            rotate = 0.0
    return {
        "pos_x": pos_x,
        "pos_y": pos_y,
        "scale": scale,
        "rotate": rotate,
        "altitude_split": altitude_split,
    }


def is_prop_like_name(name: str) -> bool:
    lowered = (name or "").lower()
    return any(token in lowered for token in PROP_NAME_TOKENS)


def drop_prop_like_nodes(gltf: dict) -> int:
    """Remove prop/entity clutter from a glTF document. Unused nodes may remain."""
    nodes = gltf.get("nodes")
    if not isinstance(nodes, list):
        return 0
    drop: set[int] = set()
    for index, node in enumerate(nodes):
        if isinstance(node, dict) and is_prop_like_name(str(node.get("name") or "")):
            drop.add(index)
    if not drop:
        return 0
    changed = True
    while changed:
        changed = False
        for index in list(drop):
            node = nodes[index] if 0 <= index < len(nodes) else None
            if not isinstance(node, dict):
                continue
            for child in node.get("children") or []:
                if isinstance(child, int) and child not in drop:
                    drop.add(child)
                    changed = True
    for node in nodes:
        if not isinstance(node, dict):
            continue
        kids = node.get("children")
        if isinstance(kids, list):
            node["children"] = [child for child in kids if child not in drop]
    for scene in gltf.get("scenes") or []:
        if isinstance(scene, dict) and isinstance(scene.get("nodes"), list):
            scene["nodes"] = [index for index in scene["nodes"] if index not in drop]
    return len(drop)


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


def _write_marker(
    dest_dir: Path,
    mesh: Path,
    cli: Path | None,
    *,
    kind: str = EXPORT_KIND,
    version: int = EXPORT_VERSION,
    extra: dict | None = None,
) -> None:
    marker = {
        "kind": kind,
        "version": version,
        "cli": _cli_stamp(cli),
        "mesh": mesh.name,
    }
    if extra:
        marker.update(extra)
    (dest_dir / MARKER_NAME).write_text(json.dumps(marker), encoding="utf-8")


def _marker_is_current(marker: dict | None, kind: str = EXPORT_KIND, version: int = EXPORT_VERSION) -> bool:
    if not marker:
        return False
    return marker.get("kind") == kind and marker.get("version") == version


def _find_mesh(dest_dir: Path, max_bytes: int | None = None) -> Path | None:
    """Newest usable mesh in the cache dir, preferring the dedicated physics export."""
    limit = MAX_MESH_BYTES if max_bytes is None else max_bytes
    if not dest_dir.is_dir():
        return None
    found = list(dest_dir.rglob("*.glb")) + list(dest_dir.rglob("*.gltf"))
    usable: list[Path] = []
    for path in found:
        try:
            size = path.stat().st_size
        except OSError:
            continue
        # glTF JSON can be small; the geometry often lives in a sidecar .bin.
        floor = 64 if path.suffix.lower() == ".gltf" else MIN_MESH_BYTES
        if floor < size <= limit:
            usable.append(path)
    if not usable:
        return None
    physics = [path for path in usable if path.stem.endswith("_physics")]
    pool = physics or usable
    glb = [path for path in pool if path.suffix.lower() == ".glb"]
    return (glb or pool)[0]


def _cached_world(
    dest_dir: Path,
    *,
    kind: str = EXPORT_KIND,
    version: int = EXPORT_VERSION,
    max_bytes: int | None = None,
) -> Path | None:
    """Cached mesh, but only when it came from the current export kind."""
    if not _marker_is_current(_read_marker(dest_dir), kind, version):
        return None
    return _find_mesh(dest_dir, max_bytes=max_bytes)


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


def _dir_bytes(dest_dir: Path) -> int:
    total = 0
    if not dest_dir.is_dir():
        return 0
    for path in dest_dir.rglob("*"):
        if not path.is_file():
            continue
        try:
            total += path.stat().st_size
        except OSError:
            continue
    return total


def _ensure_cli() -> Path | None:
    cli = find_source2viewer()
    if cli is not None:
        return cli
    try:
        return toolchain.install_source2viewer()
    except Exception:
        return None


def _run_viewer(args: list[str], timeout: int = 480) -> None:
    """Run Source2Viewer with a scratch cwd so it cannot dump textures into the repo."""
    scratch = app_data_dir() / "tmp" / "s2v"
    scratch.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(scratch),
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
        )
    finally:
        for leftover in scratch.glob("*"):
            try:
                if leftover.is_dir():
                    shutil.rmtree(leftover, ignore_errors=True)
                else:
                    leftover.unlink()
            except OSError:
                continue


def prune_preview_junk() -> dict:
    """Delete unused High/world64 dumps and Source2Viewer scratch files.

    Those folders were multi-gigabyte texture dumps. Preview no longer loads them.
    """
    home = app_data_dir()
    freed = 0
    removed: list[str] = []
    maps_dir = home / "maps"
    if maps_dir.is_dir():
        for high in maps_dir.glob("*/high"):
            if not high.is_dir():
                continue
            freed += _dir_bytes(high)
            shutil.rmtree(high, ignore_errors=True)
            removed.append(str(high))
        for stub in maps_dir.glob("*/*.glb"):
            if stub.name.endswith("_physics.glb"):
                continue
            try:
                if stub.stat().st_size < MIN_MESH_BYTES:
                    stub.unlink()
                    removed.append(str(stub))
            except OSError:
                continue
    tmp = home / "tmp"
    if tmp.is_dir():
        freed += _dir_bytes(tmp)
        shutil.rmtree(tmp, ignore_errors=True)
        removed.append(str(tmp))
    return {"ok": True, "removed": removed, "freedBytes": freed}


def _archives_for(map_vpk: Path | None) -> list[Path]:
    archives: list[Path] = []
    if map_vpk is not None:
        archives.append(map_vpk)
    try:
        from reel_core.demo.game_assets import find_pak
    except Exception:
        find_pak = None  # type: ignore[assignment]
    if find_pak is not None:
        pak = find_pak()
        if pak is not None and pak not in archives:
            archives.append(pak)
    return archives


def _extract_entry(archive: Path, entry: str, dest_dir: Path) -> Path | None:
    cli = _ensure_cli()
    if cli is None:
        return None
    dest_dir.mkdir(parents=True, exist_ok=True)
    before = {path for path in dest_dir.rglob("*") if path.is_file()}
    args = [str(cli), "-i", str(archive), "-o", str(dest_dir) + os.sep, "-d", "-f", entry]
    game = _gameinfo()
    if game is not None:
        args.extend(["--game", str(game)])
    try:
        _run_viewer(args, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        return None
    after = [path for path in dest_dir.rglob("*") if path.is_file() and path not in before]
    pngs = [path for path in after if path.suffix.lower() == ".png"]
    txts = [path for path in after if path.suffix.lower() == ".txt"]
    if pngs:
        return pngs[0]
    if txts:
        return txts[0]
    return after[0] if after else None


def _radar_image_filters(stem: str, *, lower: bool = False) -> list[str]:
    token = f"{stem}_lower_radar" if lower else f"{stem}_radar"
    names = [f"{token}_psd", token]
    prefixes = (
        "materials/panorama/images/overheadmaps/",
        "panorama/images/overheadmaps/",
        "materials/overviews/",
        "resource/overviews/",
    )
    out: list[str] = []
    for prefix in prefixes:
        for name in names:
            out.append(f"{prefix}{name}")
            out.append(f"{prefix}{name}.vtex_c")
    return out


def _overview_filters(stem: str) -> list[str]:
    return [
        f"resource/overviews/{stem}.txt",
        f"resource/overviews/{stem}",
        f"overviews/{stem}.txt",
    ]


def _cached_radar(dest_dir: Path) -> dict | None:
    marker = _read_marker(dest_dir)
    if not _marker_is_current(marker, RADAR_KIND, RADAR_VERSION):
        return None
    overview_path = dest_dir / OVERVIEW_NAME
    if not overview_path.is_file():
        return None
    try:
        payload = json.loads(overview_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    image = dest_dir / str(payload.get("image") or "radar.png")
    if not image.is_file():
        return None
    lower_name = payload.get("lower")
    lower = dest_dir / str(lower_name) if lower_name else None
    return {
        "image": str(image),
        "lower": str(lower) if lower is not None and lower.is_file() else None,
        "posX": float(payload["pos_x"]),
        "posY": float(payload["pos_y"]),
        "scale": float(payload["scale"]),
        "altitudeSplit": payload.get("altitude_split"),
    }


def extract_radar_overlay(stem: str, map_vpk: Path | None) -> dict | None:
    """Pull the local radar PNG + overview numbers into ``maps/<stem>/medium``."""
    dest_dir = maps_cache_dir() / stem / "medium"
    cached = _cached_radar(dest_dir)
    if cached is not None:
        return cached

    dest_dir.mkdir(parents=True, exist_ok=True)
    overview: dict | None = None
    radar_png: Path | None = None
    lower_png: Path | None = None
    for archive in _archives_for(map_vpk):
        if overview is None:
            for entry in _overview_filters(stem):
                found = _extract_entry(archive, entry, dest_dir / "_overview")
                if found is None:
                    continue
                try:
                    overview = parse_overview_txt(found.read_text(encoding="utf-8", errors="replace"))
                except OSError:
                    overview = None
                if overview:
                    break
        if radar_png is None:
            for entry in _radar_image_filters(stem):
                found = _extract_entry(archive, entry, dest_dir / "_radar")
                if found is not None and found.suffix.lower() == ".png":
                    radar_png = found
                    break
        if lower_png is None:
            for entry in _radar_image_filters(stem, lower=True):
                found = _extract_entry(archive, entry, dest_dir / "_lower")
                if found is not None and found.suffix.lower() == ".png":
                    lower_png = found
                    break
        if overview and radar_png:
            break

    if overview is None or radar_png is None:
        return None

    image_dest = dest_dir / "radar.png"
    try:
        image_dest.write_bytes(radar_png.read_bytes())
    except OSError:
        return None
    lower_dest: Path | None = None
    if lower_png is not None:
        lower_dest = dest_dir / "radar_lower.png"
        try:
            lower_dest.write_bytes(lower_png.read_bytes())
        except OSError:
            lower_dest = None

    payload = {
        "pos_x": overview["pos_x"],
        "pos_y": overview["pos_y"],
        "scale": overview["scale"],
        "rotate": overview.get("rotate", 0),
        "altitude_split": overview.get("altitude_split"),
        "image": image_dest.name,
        "lower": lower_dest.name if lower_dest is not None else None,
    }
    (dest_dir / OVERVIEW_NAME).write_text(json.dumps(payload), encoding="utf-8")
    _write_marker(dest_dir, image_dest, find_source2viewer(), kind=RADAR_KIND, version=RADAR_VERSION)
    return {
        "image": str(image_dest),
        "lower": str(lower_dest) if lower_dest is not None else None,
        "posX": float(payload["pos_x"]),
        "posY": float(payload["pos_y"]),
        "scale": float(payload["scale"]),
        "altitudeSplit": payload.get("altitude_split"),
    }


def _downsample_dir_pngs(dest_dir: Path, max_size: int = WORLD64_TEX_SIZE) -> int:
    from reel_core.demo.skins import downsample_png

    count = 0
    for path in dest_dir.rglob("*.png"):
        tmp = path.with_name(path.stem + ".ds.png")
        if downsample_png(path, tmp, max_size=max_size):
            try:
                os.replace(tmp, path)
                count += 1
            except OSError:
                if tmp.is_file():
                    tmp.unlink(missing_ok=True)
        else:
            if tmp.is_file():
                tmp.unlink(missing_ok=True)
    return count


def _rewrite_gltf_drop_props(dest_dir: Path) -> int:
    dropped = 0
    for path in dest_dir.rglob("*.gltf"):
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(doc, dict):
            continue
        dropped += drop_prop_like_nodes(doc)
        try:
            path.write_text(json.dumps(doc), encoding="utf-8")
        except OSError:
            continue
    return dropped


def _postprocess_world64(dest_dir: Path) -> Path | None:
    _rewrite_gltf_drop_props(dest_dir)
    _downsample_dir_pngs(dest_dir)
    if _dir_bytes(dest_dir) > MAX_WORLD64_BYTES:
        return None
    return _find_mesh(dest_dir, max_bytes=MAX_WORLD64_BYTES)


def _try_source2viewer(map_vpk: Path, dest_dir: Path) -> Path | None:
    cli = _ensure_cli()
    if cli is None:
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
            _run_viewer(args, timeout=480)
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
    """Return ``(mesh, kind)`` where kind is ``collision``, ``fallback`` or ``missing``.

    ``missing`` means the map VPK is not in the CS2 install. ``fallback`` means
    it is (or we cannot tell) but there is no collision hull to show.
    """
    stem = resolve_map_stem(map_name)
    dest_dir = maps_cache_dir() / stem
    existing = _cached_world(dest_dir)
    if existing is not None:
        return existing, EXPORT_KIND

    vpk = find_map_vpk(stem)
    if export and vpk is not None:
        exported = _try_source2viewer(vpk, dest_dir)
        if exported is not None:
            return exported, EXPORT_KIND

    fallback = write_fallback_gltf(stem, frames)
    if vpk is None and stem != "unknown":
        return fallback, MISSING_KIND
    return fallback, "fallback"


def export_map_gltf(
    map_name: str,
    frames: list[dict] | None = None,
    *,
    quality: str = "low",
) -> tuple[Path | None, str]:
    """Install Source2Viewer if needed and export the local CS2 collision mesh."""
    result = export_map_preview(map_name, frames, quality=quality)
    path = Path(result["mapGltf"]) if result.get("mapGltf") else None
    return path, str(result.get("mapSource") or "fallback")


def export_map_preview(
    map_name: str,
    frames: list[dict] | None = None,
    *,
    quality: str = "low",
) -> dict:
    """Export the mesh for a Preview quality tier. Radar extras live on the payload."""
    prune_preview_junk()
    quality = normalize_quality(quality)
    low_path, low_source = resolve_map_gltf(map_name, frames, export=True)
    stem = resolve_map_stem(map_name)
    vpk = find_map_vpk(stem)
    payload: dict = {
        "ok": True,
        "map": stem,
        "quality": quality,
        "mapInstalled": vpk is not None,
        "mapGltf": str(low_path) if low_path else None,
        "mapSource": low_source,
        "radar": None,
        "error": None,
    }

    if quality == "low" or low_source in (MISSING_KIND,):
        return payload

    # High used to export the Source 2 world mesh (64px albedos, props stripped).
    # That export spikes RAM/disk hard enough to freeze the whole machine, and
    # the resulting glTF still blows WebGL. High now shares Medium's radar hull.
    if quality in ("medium", "high"):
        radar = extract_radar_overlay(stem, vpk)
        if radar is not None and low_source == EXPORT_KIND:
            payload["radar"] = radar
            payload["mapSource"] = RADAR_KIND
        else:
            payload["error"] = f"{quality} failed, using low"
    return payload
