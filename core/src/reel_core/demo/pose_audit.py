"""Compare Preview's viewmodel pose names against the live CS2 VPK.

A wrong animation name is silent at export time (``matched no animations``), so
this audit is the only way to catch a table row that drifted from the install.
"""

from __future__ import annotations

from pathlib import Path

from reel_core.demo.game_assets import find_pak, list_pak_entries

VIEWMODEL_PREFIX = "animation/anims/viewmodel"


def _strip_ext(path: str) -> str:
    name = path.replace("\\", "/")
    if name.endswith("_c") and "." in name:
        name = name[: name.rfind(".")]
    elif "." in Path(name).name:
        name = name.rsplit(".", 1)[0]
    return name


def listed_viewmodel_anims() -> list[str]:
    """Animation clip paths under ``animation/anims/viewmodel``, no extension."""
    entries = list_pak_entries(VIEWMODEL_PREFIX)
    out: list[str] = []
    seen: set[str] = set()
    for entry in entries:
        text = _strip_ext(entry.replace("\\", "/"))
        if VIEWMODEL_PREFIX not in text:
            continue
        if text not in seen:
            seen.add(text)
            out.append(text)
    return sorted(out)


def audit_viewmodel_poses(expected: list[str]) -> dict:
    """Return which requested pose paths exist in ``pak01``.

    ``expected`` are the same strings the exporter gets, e.g.
    ``animation/anims/viewmodel/rifle/rifle_ak/idle_ak``.
    """
    pak = find_pak()
    wanted = [str(name).replace("\\", "/").strip() for name in expected if str(name).strip()]
    wanted = sorted(set(wanted))
    listed = listed_viewmodel_anims()
    if pak is None:
        return {
            "ok": False,
            "error": "pak01_dir.vpk not found",
            "expected": wanted,
            "missing": wanted,
            "found": [],
            "listed": 0,
        }
    if not listed:
        return {
            "ok": False,
            "error": "Source2Viewer listed no viewmodel animations",
            "expected": wanted,
            "missing": wanted,
            "found": [],
            "listed": 0,
        }
    index = set(listed)
    # Some listings include a parent folder only; also match by suffix.
    found: list[str] = []
    missing: list[str] = []
    for name in wanted:
        if name in index or any(item.endswith(name) or name.endswith(item) for item in index):
            found.append(name)
        else:
            missing.append(name)
    return {
        "ok": not missing,
        "expected": wanted,
        "missing": missing,
        "found": found,
        "listed": len(listed),
        "pak": str(pak),
    }
