import pytest

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
