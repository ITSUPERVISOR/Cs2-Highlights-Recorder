"""Real CS2 weapon, arms and player models for Preview.

Never ships Valve files in the repo: everything is extracted from the user's own
install into the AppData cache, exactly as the map mesh already is.

Two things about the exporter drive this module's shape.

An animation filter is **mandatory**. One agent exported without
``--gltf_animation_list`` is 1.07 GB across 2,062 animations and takes 66
seconds; the same agent filtered to the couple of dozen animations a clip
actually needs is 8.6 MB in 9.5 seconds. :func:`_require_anims` refuses to build
a command line without a filter rather than trusting callers to remember.

Animation names cannot be derived, only looked up, and a wrong name is silent —
the CLI prints ``matched no animations`` and carries on, leaving an unposed
hand. Callers pass explicit names (from the renderer's weapon table) and this
module reports back which ones the exporter did not recognise.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from reel_core.config import app_data_dir
from reel_core.recording import steam, toolchain

EXPORT_VERSION = 1

MIN_ASSET_BYTES = 512
# A filtered export is single-digit MB. This ceiling means a missing or broken
# animation filter is caught here rather than by the renderer or the disk.
MAX_ASSET_BYTES = 192 * 1024 * 1024

WEAPON_ROOT = "weapons/models"
AGENT_ROOT = "agents/models"

# The first-person arms, the sleeves over them and the third-person body all ride
# the same skeleton as the viewmodel poses, so one export serves both views and
# no retargeting is needed.
AGENT_MESHES = ("firstperson_default_gloves_arms", "firstperson_sleeves", "thirdperson_body")

DEFAULT_AGENTS = {"CT": "ctm_sas", "T": "tm_phoenix"}

# Weapons carry real motion on bolt, clip, cliprelease and trigger: shoot is 9
# keyframes over 0.267s, reload is 74 over 2.433s.
WEAPON_ANIMS = ("shoot", "reload")
# Deliberately no mesh filter for weapons. The mesh name varies by class --
# guns use body_hd, knives only ever body_legacy, grenades body, casings high --
# so filtering here silently exported an empty 1 KB karambit. The renderer picks
# the best LOD instead, which costs about 1 MB per gun and cannot lose a model.

_NO_MATCH = re.compile(r"matched no animations for:\s*(.+)", re.IGNORECASE)


class AssetExportError(RuntimeError):
    """Raised for programmer errors, notably a missing animation filter."""


def assets_cache_dir() -> Path:
    path = app_data_dir() / "assets"
    path.mkdir(parents=True, exist_ok=True)
    return path


def find_source2viewer() -> Path | None:
    return toolchain.find_source2viewer()


def find_pak() -> Path | None:
    """The main CS2 content archive holding weapons, agents and animations."""
    folder = steam.get_cs2_folder()
    if folder is None:
        return None
    candidates = [
        folder / "game" / "csgo" / "pak01_dir.vpk",
        folder / "csgo" / "pak01_dir.vpk",
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


def _cli_stamp(cli: Path | None) -> str:
    """Identity for the exporter binary, so a CLI upgrade invalidates the cache."""
    if cli is None:
        return "none"
    try:
        stat = cli.stat()
    except OSError:
        return "unknown"
    return f"{stat.st_size}:{stat.st_mtime_ns}"


def _marker_path(glb: Path) -> Path:
    return glb.with_suffix(".export.json")


def _read_marker(glb: Path) -> dict | None:
    path = _marker_path(glb)
    if not path.is_file():
        return None
    try:
        marker = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return marker if isinstance(marker, dict) else None


def _write_marker(glb: Path, cli: Path | None, anims: list[str]) -> None:
    marker = {
        "version": EXPORT_VERSION,
        "cli": _cli_stamp(cli),
        "anims": sorted(anims),
    }
    try:
        _marker_path(glb).write_text(json.dumps(marker), encoding="utf-8")
    except OSError:
        pass


def _glb_json(path: Path, max_bytes: int = 64 * 1024 * 1024) -> dict | None:
    """The JSON chunk of a .glb, or None if it is not a readable glB."""
    try:
        with path.open("rb") as handle:
            if handle.read(4) != b"glTF":
                return None
            handle.seek(12)
            head = handle.read(8)
            if len(head) < 8 or head[4:8] != b"JSON":
                return None
            length = int.from_bytes(head[0:4], "little")
            if length <= 0 or length > max_bytes:
                return None
            payload = handle.read(length)
        doc = json.loads(payload.decode("utf-8", "replace"))
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def _has_geometry(glb: Path) -> bool:
    """Guard against a cached export that parsed fine but contains no mesh.

    A mesh filter that matches nothing produces a valid, tiny glb rather than an
    error, so size alone is not enough to call an export good.
    """
    doc = _glb_json(glb)
    if doc is None:
        return False
    for mesh in doc.get("meshes") or []:
        if isinstance(mesh, dict) and mesh.get("primitives"):
            return True
    return False


def _usable(glb: Path) -> bool:
    try:
        size = glb.stat().st_size
    except OSError:
        return False
    if not (MIN_ASSET_BYTES < size <= MAX_ASSET_BYTES):
        return False
    return _has_geometry(glb)


def _is_current(glb: Path, cli: Path | None, anims: list[str]) -> bool:
    """Cached only when the version, exporter and animation coverage all match.

    Animations are a *superset* check: a cache holding more poses than this clip
    needs is still valid, which keeps a second clip with a different gun from
    re-exporting the whole agent.
    """
    if not _usable(glb):
        return False
    marker = _read_marker(glb)
    if not marker or marker.get("version") != EXPORT_VERSION:
        return False
    if marker.get("cli") != _cli_stamp(cli):
        return False
    cached = marker.get("anims")
    if not isinstance(cached, list):
        return False
    return set(anims).issubset(set(cached))


def _require_anims(anims: list[str]) -> list[str]:
    clean = [str(name).strip() for name in anims if str(name).strip()]
    if not clean:
        raise AssetExportError(
            "refusing to export without an animation filter: an unfiltered agent is 1.07 GB / 66 s",
        )
    # Duplicates would bloat the command line for no gain.
    return sorted(set(clean))


def _resolve_cli() -> Path | None:
    cli = find_source2viewer()
    if cli is not None:
        return cli
    try:
        return toolchain.install_source2viewer()
    except Exception:
        return None


def _run_cli(args: list[str], timeout: int = 900) -> tuple[bool, str]:
    try:
        proc = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False, ""
    return proc.returncode == 0, f"{proc.stdout or ''}\n{proc.stderr or ''}"


def _unmatched(output: str) -> list[str]:
    """Animation names the exporter did not recognise, which it only warns about."""
    missing: list[str] = []
    for line in _NO_MATCH.findall(output or ""):
        for name in line.split(","):
            trimmed = name.strip()
            if trimmed:
                missing.append(trimmed.split("/")[-1])
    return missing


def _base_args(cli: Path, pak: Path) -> list[str]:
    args = [
        str(cli),
        "-i",
        str(pak),
        "-d",
        "--gltf_export_format",
        "glb",
        "--gltf_export_animations",
        # jump_additive_* and flinch_* are delta tracks; without this they apply
        # as offsets from nothing.
        "--gltf_compose_additive",
    ]
    game = _gameinfo()
    if game is not None:
        args.extend(["--game", str(game)])
    # No --gltf_export_materials: CS2 ships 4K textures, 66.6 MB for the AK alone.
    return args


def weapon_glb(model: str) -> Path:
    return assets_cache_dir() / WEAPON_ROOT / f"{model}.glb"


def agent_glb(agent: str) -> Path:
    return assets_cache_dir() / AGENT_ROOT / agent / f"{agent}.glb"


def export_weapons(models: list[str]) -> tuple[dict[str, str], list[str]]:
    """Export weapon models in one batched call. Returns ``(paths, missing)``.

    ``models`` are paths under ``weapons/models`` without extension, e.g.
    ``ak47/weapon_rif_ak47``. Only weapons absent from the cache are exported.
    """
    wanted = [str(m).strip().strip("/") for m in models if str(m).strip()]
    wanted = sorted(set(wanted))
    if not wanted:
        return {}, []

    cli = _resolve_cli()
    pak = find_pak()
    found: dict[str, str] = {}
    todo: list[str] = []
    anims = list(WEAPON_ANIMS)

    for model in wanted:
        glb = weapon_glb(model)
        if _is_current(glb, cli, anims):
            found[model] = str(glb)
        else:
            todo.append(model)

    if not todo or cli is None or pak is None:
        return found, todo

    cache = assets_cache_dir()
    cache.mkdir(parents=True, exist_ok=True)
    # One call for the whole clip: -f takes a comma-separated list.
    targets = ",".join(f"{WEAPON_ROOT}/{model}.vmdl_c" for model in todo)
    args = [
        *_base_args(cli, pak),
        "--gltf_animation_list",
        ",".join(_require_anims(anims)),
        "-o",
        str(cache),
        "-f",
        targets,
    ]
    _run_cli(args)

    missing: list[str] = []
    for model in todo:
        glb = weapon_glb(model)
        if _usable(glb):
            _write_marker(glb, cli, anims)
            found[model] = str(glb)
        else:
            missing.append(model)
    return found, missing


def export_agent(agent: str, anims: list[str]) -> tuple[str | None, list[str]]:
    """Export one agent's first-person arms, sleeves and body plus ``anims``.

    Returns ``(path, unmatched)`` where ``unmatched`` lists animation names the
    exporter did not recognise — the failure that otherwise silently produces an
    unposed hand.
    """
    name = str(agent or "").strip().strip("/")
    if not name:
        return None, []
    wanted = _require_anims(anims)

    cli = _resolve_cli()
    glb = agent_glb(name)
    if _is_current(glb, cli, wanted):
        return str(glb), []

    pak = find_pak()
    if cli is None or pak is None:
        return None, wanted

    # Re-export the union so a second clip needing one more pose does not drop
    # the poses already cached.
    marker = _read_marker(glb)
    cached = marker.get("anims") if isinstance(marker, dict) else None
    if isinstance(cached, list) and _usable(glb):
        wanted = sorted(set(wanted) | {str(a) for a in cached})

    cache = assets_cache_dir()
    cache.mkdir(parents=True, exist_ok=True)
    args = [
        *_base_args(cli, pak),
        "--gltf_animation_list",
        ",".join(wanted),
        "--gltf_mesh_list",
        ",".join(AGENT_MESHES),
        "-o",
        str(cache),
        "-f",
        f"{AGENT_ROOT}/{name}/{name}.vmdl_c",
    ]
    ok, output = _run_cli(args)
    unmatched = _unmatched(output)
    if not _usable(glb):
        return None, unmatched or wanted
    _write_marker(glb, cli, wanted)
    return str(glb), unmatched


def export_assets(spec: dict) -> dict:
    """Export everything one clip needs.

    ``spec`` is ``{"weapons": [...], "agents": {"<agent>": ["<anim>", ...]}}``,
    built by the renderer because the weapon table and the animation names live
    there.
    """
    weapons_in = spec.get("weapons") or []
    agents_in = spec.get("agents") or {}

    weapons, weapons_missing = export_weapons(list(weapons_in))

    agents: dict[str, str] = {}
    unmatched: dict[str, list[str]] = {}
    jobs = list(agents_in.items()) if isinstance(agents_in, dict) else []

    def _one(item: tuple[object, object]) -> tuple[str, str | None, list[str]]:
        agent, anims = item
        try:
            path, missing = export_agent(str(agent), list(anims or []))
        except AssetExportError:
            # A caller that forgot the filter should not take the clip down.
            path, missing = None, []
        return str(agent), path, missing

    if len(jobs) <= 1:
        results = [_one(jobs[0])] if jobs else []
    else:
        workers = min(4, len(jobs))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            results = list(pool.map(_one, jobs))

    for agent, path, missing in results:
        if path:
            agents[agent] = path
        if missing:
            unmatched[agent] = sorted(set(missing))

    return {
        "ok": bool(weapons or agents),
        "weapons": weapons,
        "agents": agents,
        "weaponsMissing": sorted(weapons_missing),
        "unmatchedAnims": unmatched,
        "cacheDir": str(assets_cache_dir()),
    }
