"""Clip-scoped 64px weapon-skin albedos from the local CS2 VPK.

Never dumps native 4K materials: the AK alone was 66.6 MB that way. Each finish
is one tiny nearest-filtered color map in AppData, keyed by paint kit, applied
on the shared untextured gun mesh for a PS1-quality Preview look.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import struct
import zlib
from pathlib import Path

from reel_core.config import app_data_dir
from reel_core.demo.game_assets import find_pak, list_pak_entries, _resolve_cli, _run_cli, _gameinfo

SKIN_SIZE = 64
SKIN_VERSION = 2
MAX_SKIN_BYTES = 2 * 1024 * 1024
PAINTS_PREFIX = "materials/models/weapons/customization/paints"
ITEMS_GAME = "scripts/items/items_game.txt"


def skins_cache_dir() -> Path:
    path = app_data_dir() / "skins"
    path.mkdir(parents=True, exist_ok=True)
    return path


def skin_key(weapon: str, skin: str, paint_kit: int) -> str:
    if paint_kit and int(paint_kit) > 0:
        return str(int(paint_kit))
    slug = re.sub(r"[^a-z0-9]+", "_", str(skin or "").lower()).strip("_")
    if slug and slug not in ("default", "vanilla", "none"):
        return slug
    return ""


def _write_rgb_png(path: Path, rgb: tuple[int, int, int], size: int = 64) -> None:
    raw = b"".join(b"\x00" + bytes(rgb) * size for _ in range(size))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def _parse_rgb(value: object) -> tuple[int, int, int] | None:
    text = str(value or "").strip()
    if not text:
        return None
    nums = re.findall(r"[-+]?\d*\.?\d+", text)
    if len(nums) < 3:
        return None
    vals = [float(n) for n in nums[:3]]
    if max(vals) <= 1.0:
        vals = [v * 255.0 for v in vals]
    return tuple(max(0, min(255, int(round(v)))) for v in vals)  # type: ignore[return-value]


def downsample_png(src: Path, dest: Path, max_size: int = SKIN_SIZE) -> bool:
    """Write a <=64px PNG. Prefers Pillow; copies small files if it is absent."""
    try:
        from PIL import Image
    except ImportError:
        try:
            if src.stat().st_size <= 400_000:
                shutil.copyfile(src, dest)
                return dest.is_file()
        except OSError:
            return False
        return False
    try:
        resample = Image.Resampling.NEAREST if hasattr(Image, "Resampling") else Image.NEAREST
        with Image.open(src) as image:
            image = image.convert("RGBA")
            image.thumbnail((max_size, max_size), resample)
            dest.parent.mkdir(parents=True, exist_ok=True)
            image.save(dest, "PNG", optimize=True)
        return dest.is_file() and dest.stat().st_size <= MAX_SKIN_BYTES
    except OSError:
        return False


def _extract_file(vpk_path: str, dest_dir: Path) -> Path | None:
    cli = _resolve_cli()
    pak = find_pak()
    if cli is None or pak is None:
        return None
    dest_dir.mkdir(parents=True, exist_ok=True)
    args = [str(cli), "-i", str(pak), "-o", str(dest_dir) + os.sep, "-d", "-f", vpk_path]
    game = _gameinfo()
    if game is not None:
        args.extend(["--game", str(game)])
    _run_cli(args, timeout=120)
    found = list(dest_dir.rglob("*"))
    files = [p for p in found if p.is_file() and p.suffix.lower() in {".png", ".jpg", ".jpeg", ".tga", ".txt", ".vmat"}]
    pngs = [p for p in files if p.suffix.lower() == ".png"]
    if pngs:
        return pngs[0]
    return files[0] if files else None


def _items_game_path() -> Path | None:
    cached = skins_cache_dir() / "items_game.txt"
    if cached.is_file() and cached.stat().st_size > 1024:
        return cached
    extracted = _extract_file(ITEMS_GAME, skins_cache_dir() / "_items")
    if extracted is None:
        return cached if cached.is_file() else None
    if extracted.suffix.lower() == ".txt":
        try:
            shutil.copyfile(extracted, cached)
            return cached
        except OSError:
            return extracted
    return extracted


def _paint_kit_block(text: str) -> str:
    match = re.search(r'"paint_kits"\s*\{', text)
    if not match:
        return ""
    start = match.end()
    depth = 1
    i = start
    while i < len(text) and depth:
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
        i += 1
    return text[start : i - 1]


def _parse_paint_kits(text: str) -> dict[str, dict]:
    """id -> {name, pattern, colors} from the items_game paint_kits block."""
    block = _paint_kit_block(text)
    kits: dict[str, dict] = {}
    for match in re.finditer(
        r'"(\d+)"\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}',
        block,
        flags=re.DOTALL,
    ):
        kit_id = match.group(1)
        body = match.group(2)
        fields: dict[str, str] = {}
        for key, value in re.findall(r'"([^"]+)"\s+"([^"]*)"', body):
            fields[key.lower()] = value
        name = fields.get("name") or ""
        pattern = fields.get("pattern") or ""
        colors = []
        for key in ("color0", "color1", "color2", "color3"):
            rgb = _parse_rgb(fields.get(key))
            if rgb:
                colors.append(rgb)
        kits[kit_id] = {"id": int(kit_id), "name": name, "pattern": pattern, "colors": colors}
        if name:
            kits[name.lower()] = kits[kit_id]
    return kits


def paint_kit_index() -> dict[str, dict]:
    marker = skins_cache_dir() / "paintkits.json"
    if marker.is_file():
        try:
            data = json.loads(marker.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("version") == SKIN_VERSION:
                kits = data.get("kits")
                if isinstance(kits, dict):
                    return kits
        except (OSError, ValueError):
            pass
    path = _items_game_path()
    if path is None or not path.is_file():
        return {}
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    kits = _parse_paint_kits(text)
    try:
        marker.write_text(json.dumps({"version": SKIN_VERSION, "kits": kits}), encoding="utf-8")
    except OSError:
        pass
    return kits


def _paints_index() -> list[str]:
    marker = skins_cache_dir() / "paints-index.json"
    if marker.is_file():
        try:
            data = json.loads(marker.read_text(encoding="utf-8"))
            if isinstance(data, list) and data:
                return [str(x) for x in data]
        except (OSError, ValueError):
            pass
    entries = list_pak_entries(PAINTS_PREFIX, "vtex_c")
    if not entries:
        entries = list_pak_entries(PAINTS_PREFIX)
    paths = [e.replace("\\", "/") for e in entries if "paints" in e.replace("\\", "/").lower()]
    try:
        marker.write_text(json.dumps(paths), encoding="utf-8")
    except OSError:
        pass
    return paths


def _find_pattern_vtex(pattern: str, paints: list[str]) -> str | None:
    needle = re.sub(r"[^a-z0-9]+", "", pattern.lower())
    if not needle:
        return None
    hits = []
    for path in paints:
        stem = Path(path).stem.lower().removesuffix(".vtex")
        key = re.sub(r"[^a-z0-9]+", "", stem)
        if key == needle or key.endswith(needle):
            hits.append(path)
    if not hits:
        return None
    # Prefer color/albedo-looking names over masks.
    hits.sort(key=lambda p: (0 if any(tag in p.lower() for tag in ("color", "albedo", "diffuse", "pattern")) else 1, len(p)))
    return hits[0]


def _lookup_kit(skin: str, paint_kit: int, kits: dict[str, dict]) -> dict | None:
    if paint_kit and str(int(paint_kit)) in kits:
        return kits[str(int(paint_kit))]
    slug = str(skin or "").strip().lower()
    if not slug:
        return None
    if slug in kits:
        return kits[slug]
    compact = re.sub(r"[^a-z0-9]+", "", slug)
    for key, kit in kits.items():
        if not isinstance(kit, dict):
            continue
        name = str(kit.get("name") or "").lower()
        pattern = str(kit.get("pattern") or "").lower()
        if compact and compact in re.sub(r"[^a-z0-9]+", "", name + pattern):
            return kit
        if slug and slug in name:
            return kit
    return None


def _skin_png(key: str) -> Path:
    return skins_cache_dir() / f"{key}.png"


def _is_current_skin(path: Path) -> bool:
    try:
        size = path.stat().st_size
    except OSError:
        return False
    if not (64 < size <= MAX_SKIN_BYTES):
        return False
    marker = path.with_suffix(".export.json")
    if not marker.is_file():
        return True
    try:
        data = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return True
    return data.get("version") == SKIN_VERSION


def export_skins(requests: list[dict] | list[object]) -> dict[str, str]:
    """Export 64px albedos for the paint kits that appear in a clip.

    ``requests`` items are ``{weapon, skin, paintKit}``. Missing kits are skipped
    so a clip still plays in gunmetal.
    """
    wanted: list[tuple[str, str, int]] = []
    for item in requests or []:
        if isinstance(item, dict):
            weapon = str(item.get("weapon") or "")
            skin = str(item.get("skin") or "")
            try:
                paint = int(item.get("paintKit") or 0)
            except (TypeError, ValueError):
                paint = 0
        else:
            continue
        key = skin_key(weapon, skin, paint)
        if key:
            wanted.append((key, skin, paint))
    unique: dict[str, tuple[str, int]] = {}
    for key, skin, paint in wanted:
        unique.setdefault(key, (skin, paint))
    if not unique:
        return {}

    found: dict[str, str] = {}
    todo = {key: pair for key, pair in unique.items() if not _is_current_skin(_skin_png(key))}
    for key, _pair in unique.items():
        path = _skin_png(key)
        if key not in todo and path.is_file():
            found[key] = str(path)
    if not todo:
        return found

    kits = paint_kit_index()
    paints = _paints_index() if kits else []
    scratch = skins_cache_dir() / "_raw"
    scratch.mkdir(parents=True, exist_ok=True)

    for key, (skin, paint) in todo.items():
        dest = _skin_png(key)
        kit = _lookup_kit(skin, paint, kits)
        wrote = False
        if kit and kit.get("pattern"):
            vtex = _find_pattern_vtex(str(kit["pattern"]), paints)
            if vtex:
                target = vtex if vtex.endswith("_c") else f"{vtex}_c"
                raw = _extract_file(target, scratch / key)
                if raw and raw.suffix.lower() in {".png", ".jpg", ".jpeg", ".tga"}:
                    wrote = downsample_png(raw, dest)
        if not wrote and kit and kit.get("colors"):
            _write_rgb_png(dest, kit["colors"][0], 64)
            wrote = dest.is_file()
        if wrote:
            try:
                dest.with_suffix(".export.json").write_text(
                    json.dumps({"version": SKIN_VERSION, "key": key}),
                    encoding="utf-8",
                )
            except OSError:
                pass
            found[key] = str(dest)
    return found


def export_all_skins() -> dict[str, str]:
    """Optional whole-catalog bake at 64px. Never 4K. Writes into AppData only."""
    kits = paint_kit_index()
    requests: list[dict] = []
    seen: set[int] = set()
    for kit in kits.values():
        if not isinstance(kit, dict):
            continue
        try:
            kid = int(kit.get("id") or 0)
        except (TypeError, ValueError):
            continue
        if kid <= 0 or kid in seen:
            continue
        seen.add(kid)
        requests.append({"weapon": "", "skin": str(kit.get("name") or ""), "paintKit": kid})
    return export_skins(requests)
