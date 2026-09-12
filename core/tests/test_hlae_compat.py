from datetime import datetime, timezone

from reel_core.recording.toolchain import assess_hlae_vs_cs2


CS2 = datetime(2026, 9, 9, tzinfo=timezone.utc)
HLAE = datetime(2026, 7, 29, tzinfo=timezone.utc)


def test_compatible_when_hlae_is_newer_than_cs2():
    check = assess_hlae_vs_cs2(
        cs2_version="141.8.1",
        cs2_date=datetime(2026, 7, 1, tzinfo=timezone.utc),
        hlae_tag="v2.192.1",
        hlae_date=HLAE,
        latest={"tag": "v2.192.1", "published_at": "2026-07-29T08:33:04Z"},
    )
    assert check.ok is True
    assert check.action is None


def test_offers_update_when_github_has_newer_zip():
    check = assess_hlae_vs_cs2(
        cs2_version="141.8.1",
        cs2_date=CS2,
        hlae_tag="v2.192.1",
        hlae_date=HLAE,
        latest={"tag": "v2.193.0", "published_at": "2026-09-10T00:00:00Z"},
    )
    assert check.ok is False
    assert check.action == "update"
    assert "v2.193.0" in check.hint


def test_no_update_when_already_on_latest_hlae():
    check = assess_hlae_vs_cs2(
        cs2_version="141.8.1",
        cs2_date=CS2,
        hlae_tag="v2.192.1",
        hlae_date=HLAE,
        latest={"tag": "v2.192.1", "published_at": "2026-07-29T08:33:04Z"},
    )
    assert check.ok is None
    assert check.action is None
    assert "newest HLAE" in check.hint
    assert "Watch" in check.hint


def test_no_update_when_github_unreachable():
    check = assess_hlae_vs_cs2(
        cs2_version="141.8.1",
        cs2_date=CS2,
        hlae_tag="v2.192.1",
        hlae_date=HLAE,
        latest=None,
    )
    assert check.ok is None
    assert check.action is None
    assert "Could not reach GitHub" in check.hint
