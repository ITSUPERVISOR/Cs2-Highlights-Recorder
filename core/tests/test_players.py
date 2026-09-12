from conftest import make_demo, make_kill, make_round

from reel_core.demo.players import PlayerNotFound, resolve_player, resolve_pov
from reel_core.steamids import account_id, canonicalize_steamid, pick_login_steamid


SLK = "76561198855944675"
SYMLINK = "76561198335362931"
CAKE = "76561199508411274"


def test_canonicalize_account_id_and_float():
    assert canonicalize_steamid(SLK) == SLK
    assert canonicalize_steamid(int(SLK)) == SLK
    assert canonicalize_steamid(account_id(SLK)) == SLK
    assert canonicalize_steamid("0") == ""
    assert canonicalize_steamid(None) == ""


def test_pick_login_uses_timestamp_when_most_recent_missing():
    users = {
        SYMLINK: {"Timestamp": "1761479692", "PersonaName": "Symlink"},
        CAKE: {"Timestamp": "1788636127", "PersonaName": "BetterCake"},
        SLK: {"Timestamp": "1788723673", "PersonaName": "SLK"},
    }
    assert pick_login_steamid(users) == SLK


def test_pick_login_prefers_most_recent_flag():
    users = {
        SLK: {"Timestamp": "1", "MostRecent": "0"},
        SYMLINK: {"Timestamp": "0", "MostRecent": "1"},
    }
    assert pick_login_steamid(users) == SYMLINK


def test_resolve_player_accepts_account_id():
    demo = make_demo([make_kill(1000, attacker=SLK, victim=CAKE)], [make_round(0, 0, 5000)])
    demo.player_names[SLK] = "SLK"
    demo.player_names[CAKE] = "BetterCake"
    assert resolve_player(demo, account_id(SLK)) == SLK
    assert resolve_player(demo, SLK) == SLK


def test_resolve_pov_falls_back_to_local_account_in_demo():
    demo = make_demo([make_kill(1000, attacker=SLK, victim="999")], [make_round(0, 0, 5000)])
    demo.player_names[SLK] = "SLK"
    assert resolve_pov(demo, SYMLINK, [SLK, SYMLINK, CAKE]) == SLK


def test_resolve_pov_errors_with_roster_when_no_local_account():
    demo = make_demo([make_kill(1000, attacker="111", victim="222")], [make_round(0, 0, 5000)])
    try:
        resolve_pov(demo, SYMLINK, [SYMLINK])
        assert False, "expected PlayerNotFound"
    except PlayerNotFound as exc:
        assert "Players:" in str(exc)
