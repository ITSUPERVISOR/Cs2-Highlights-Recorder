import pytest
from pathlib import Path

from reel_core.demo.game_assets import (
    AssetExportError,
    _require_anims,
    _unmatched,
    export_assets,
)


def test_require_anims_refuses_empty():
    with pytest.raises(AssetExportError):
        _require_anims([])
    with pytest.raises(AssetExportError):
        _require_anims(["", "  "])


def test_require_anims_dedupes_and_sorts():
    assert _require_anims(["shoot", "reload", "shoot"]) == ["reload", "shoot"]


def test_unmatched_parses_cli_warning():
    log = (
        "--- glTF animation filter matched no animations for: "
        "animation/anims/viewmodel/pistol/pistol_glock18/idle_glock18, "
        "animation/anims/viewmodel/pistol/pistol_glock18/shoot1_glock18\n"
    )
    missing = _unmatched(log)
    assert any(name.endswith("idle_glock18") for name in missing)
    assert any(name.endswith("shoot1_glock18") for name in missing)


def test_export_assets_empty_spec_is_ok():
    payload = export_assets({"weapons": [], "agents": {}})
    assert payload["weapons"] == {}
    assert payload["agents"] == {}
    assert payload["weaponsMissing"] == []
    assert payload.get("skins") == {}


def test_parse_pak_list_skips_banners():
    from reel_core.demo.game_assets import parse_pak_list_output

    listed = parse_pak_list_output(
        "Source2Viewer-CLI\n"
        "animation/anims/viewmodel/rifle/rifle_ak/idle_ak.vanim_c\n"
        "https://example.invalid/nope\n"
        "weapons/models/ak47/weapon_rif_ak47.vmdl_c\n"
    )
    assert listed == [
        "animation/anims/viewmodel/rifle/rifle_ak/idle_ak.vanim_c",
        "weapons/models/ak47/weapon_rif_ak47.vmdl_c",
    ]


def test_pose_audit_matches_listed_paths(monkeypatch):
    from reel_core.demo import pose_audit

    monkeypatch.setattr(pose_audit, "find_pak", lambda: Path("pak01_dir.vpk"))
    monkeypatch.setattr(
        pose_audit,
        "listed_viewmodel_anims",
        lambda: ["animation/anims/viewmodel/rifle/rifle_ak/idle_ak"],
    )
    result = pose_audit.audit_viewmodel_poses(
        [
            "animation/anims/viewmodel/rifle/rifle_ak/idle_ak",
            "animation/anims/viewmodel/pistol/pistol_glock18/idle_glock",
        ]
    )
    assert result["ok"] is False
    assert result["found"] == ["animation/anims/viewmodel/rifle/rifle_ak/idle_ak"]
    assert result["missing"] == ["animation/anims/viewmodel/pistol/pistol_glock18/idle_glock"]


def test_warm_spec_covers_guns_and_both_agents():
    from reel_core.demo.warm_assets import FALLBACK_AGENT, T_AGENT, WEAPON_MODELS, warm_spec

    spec = warm_spec()
    assert "ak47/weapon_rif_ak47" in spec["weapons"]
    assert len(spec["weapons"]) == len(WEAPON_MODELS)
    assert any("run_n_rifle" in name for name in spec["agents"][FALLBACK_AGENT])
    assert any("run_n_pistol" in name for name in spec["agents"][T_AGENT])


def test_skin_key_and_solid_png(tmp_path: Path, monkeypatch):
    from reel_core.demo import skins

    assert skins.skin_key("ak47", "Asiimov", 44) == "44"
    assert skins.skin_key("ak47", "Asiimov", 0) == "asiimov"
    assert skins.skin_key("ak47", "default", 0) == ""
    assert skins.SKIN_SIZE == 64
    dest = tmp_path / "red.png"
    skins._write_rgb_png(dest, (255, 0, 0), 8)
    assert dest.is_file() and dest.stat().st_size > 32


def test_parse_paint_kits_reads_pattern_and_color():
    from reel_core.demo.skins import _parse_paint_kits

    text = '''
    "items_game"
    {
        "paint_kits"
        {
            "44"
            {
                "name" "cu_ak47_asiimov"
                "pattern" "ak47_asiimov"
                "color0" "{105 54 29}"
            }
        }
    }
    '''
    kits = _parse_paint_kits(text)
    assert kits["44"]["name"] == "cu_ak47_asiimov"
    assert kits["44"]["pattern"] == "ak47_asiimov"
    assert kits["cu_ak47_asiimov"]["id"] == 44
    assert kits["44"]["colors"][0] == (105, 54, 29)
