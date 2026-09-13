"""reel-core CLI: doctor, parse, watch, record, update-tools."""

from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

import click

from reel_core import __version__
from reel_core.analysis import analyze
from reel_core.config import Config, app_data_dir, load_config
from reel_core.demo.parser import DemoData, ensure_dem_file, parse_demo
from reel_core.demo.players import PlayerNotFound, resolve_pov
from reel_core.models import CameraAction, Sequence
from reel_core.serialize import parse_payload
from reel_core.util.log import console, info


def _work_dir(config: Config, demo_path: Path) -> Path:
    if config.paths.work_dir != "auto":
        return Path(config.paths.work_dir) / demo_path.stem
    return app_data_dir() / "work" / demo_path.stem


def _accounts_payload():
    from reel_core.recording.steam import list_steam_accounts

    return [
        {
            "steamid": account.steamid,
            "accountName": account.account_name,
            "personaName": account.persona_name,
            "mostRecent": account.most_recent,
            "timestamp": account.timestamp,
        }
        for account in list_steam_accounts()
    ]


def _resolve_cli_player(parsed: DemoData, player: str | None) -> str | None:
    from reel_core.recording.steam import list_steam_accounts

    local_ids = [account.steamid for account in list_steam_accounts()]
    try:
        return resolve_pov(parsed, player, local_ids)
    except PlayerNotFound as exc:
        raise click.ClickException(str(exc)) from exc


def _load_and_parse(demo: Path, config: Config) -> tuple[Path, DemoData]:
    work_dir = _work_dir(config, demo)
    work_dir.mkdir(parents=True, exist_ok=True)
    demo_path = ensure_dem_file(demo, work_dir)
    return demo_path, parse_demo(demo_path)


@click.group()
@click.version_option(__version__)
def main() -> None:
    """CS2 Reel core — parse, score, watch and record personal highlights."""


@main.command()
@click.option("--json", "as_json", is_flag=True, help="Machine-readable output")
def doctor(as_json: bool) -> None:
    """Check Steam, CS2, HLAE, FFmpeg and the CS2 plugin."""
    from reel_core.recording import steam, toolchain

    config = load_config()
    checks: list[dict] = []

    def add(
        name: str,
        ok: bool | None,
        detail: str,
        hint: str = "",
        *,
        impact: str = "",
        action: str | None = None,
    ) -> None:
        checks.append(
            {
                "name": name,
                "ok": ok,
                "detail": detail,
                "hint": hint,
                "impact": impact,
                "action": action,
            }
        )

    steam_folder = steam.get_steam_folder()
    add(
        "Steam installed",
        steam_folder is not None,
        str(steam_folder or "registry key not found"),
        impact="" if steam_folder else "Watch and record need Steam installed",
    )

    accounts = steam.list_steam_accounts()
    steamid = steam.detect_steamid64()
    if steamid:
        chosen = next((account for account in accounts if account.steamid == steamid), None)
        label = steamid
        if chosen and chosen.persona_name:
            label = f"{steamid} ({chosen.persona_name})"
        hint = ""
        if len(accounts) > 1:
            others = ", ".join(
                f"{account.persona_name or account.steamid}"
                for account in accounts
                if account.steamid != steamid
            )
            hint = (
                f"This PC has {len(accounts)} Steam accounts. Others: {others}. "
                "Change in Settings if this is the wrong POV."
            )
        add("SteamID64", True, label, hint)
    else:
        add(
            "SteamID64",
            False,
            "loginusers.vdf not found",
            impact="POV detection and Watch need a Steam account",
        )

    cs2_folder = steam.get_cs2_folder()
    if config.paths.cs2_exe != "auto":
        cs2_exe = Path(config.paths.cs2_exe)
    else:
        cs2_exe = steam.get_cs2_exe(cs2_folder) if cs2_folder else None
    cs2_ok = cs2_exe is not None and cs2_exe.is_file()
    add(
        "CS2 installed",
        cs2_ok,
        str(cs2_exe or "app 730 not found in Steam library"),
        impact="" if cs2_ok else "Parse, Watch, and Record need CS2 installed",
    )

    steam_running = steam.is_steam_running()
    add(
        "Steam running",
        steam_running,
        "required at record/watch time" if not steam_running else "running",
        impact="" if steam_running else "Watch and Record need Steam running when you launch CS2",
    )

    hlae = toolchain.find_hlae(config)
    add(
        "HLAE",
        True if hlae else False,
        str(hlae or "missing — install tools"),
        impact="" if hlae else "Record queue will not work without HLAE",
        action=None if hlae else "install",
    )

    if hlae and cs2_folder:
        inf = steam.read_steam_inf(cs2_folder)
        hlae_info = toolchain.read_hlae_install_info(hlae)
        cs2_date = hlae_date = None
        try:
            cs2_date = datetime.strptime(inf.get("VersionDate", ""), "%b %d %Y").replace(tzinfo=timezone.utc)
            hlae_date = datetime.fromisoformat(hlae_info.get("published_at", "").replace("Z", "+00:00"))
        except ValueError:
            pass
        if cs2_date and hlae_date:
            latest = toolchain.fetch_latest_hlae_info()
            verdict = toolchain.assess_hlae_vs_cs2(
                cs2_version=inf.get("PatchVersion", "?"),
                cs2_date=cs2_date,
                hlae_tag=hlae_info.get("tag", ""),
                hlae_date=hlae_date,
                latest=latest,
            )
            add(
                "HLAE vs CS2 build",
                verdict.ok,
                verdict.detail,
                verdict.hint,
                impact=verdict.impact,
                action=verdict.action,
            )
        else:
            add("HLAE vs CS2 build", None, "could not compare dates (install-info.json or steam.inf missing)")

    ffmpeg = toolchain.find_ffmpeg(config)
    add(
        "FFmpeg",
        True if ffmpeg else False,
        str(ffmpeg or "missing — install tools"),
        impact="" if ffmpeg else "Record queue cannot encode clips without FFmpeg",
        action=None if ffmpeg else "install",
    )

    plugin_dll = toolchain.find_plugin_dll(config)
    add(
        "CS2 server plugin",
        plugin_dll is not None,
        str(plugin_dll or "missing — install tools (fetches CSDM server.dll from GitHub)"),
        impact="" if plugin_dll else "Record cannot inject the demo plugin without server.dll",
        action=None if plugin_dll else "install",
    )

    s2v = toolchain.find_source2viewer()
    add(
        "Source2Viewer CLI",
        True if s2v else None,
        str(s2v or "missing — Preview will install this on first map export"),
        impact="" if s2v else "Until then Preview uses a fallback floor instead of the CS2 map mesh",
        action=None if s2v else "install",
    )

    if cs2_folder is not None:
        from reel_core.demo.map_assets import list_installed_maps

        maps = list_installed_maps()
        add(
            "CS2 maps",
            True if maps else None,
            f"{len(maps)} map VPK(s) in install" if maps else "no playable maps/*.vpk found",
            impact="" if maps else "Preview will use a flat ground plane until CS2 maps are installed",
        )

    if cs2_folder is not None:
        from reel_core.recording.plugin import gameinfo_status

        ok, detail, hint = gameinfo_status(cs2_folder)
        add(
            "gameinfo.gi writable",
            ok,
            detail,
            hint,
            impact="" if ok else "Record cannot register the CS2 plugin until gameinfo.gi is writable",
        )

    if config.recording.unattended:
        add(
            "Unattended record",
            True,
            "recording.unattended=true — CS2 stays visible in the background (do not minimize)",
            "MIRV capture needs an on-screen window. Set recording.unattended=false in config.toml to require focus.",
        )
    else:
        add(
            "Unattended record",
            None,
            "recording.unattended=false — keep CS2 focused during Record",
            "Enable unattended in config.toml under [recording] unattended = true",
        )

    add(
        "No-CS2 recording",
        None,
        "not supported — clips need a live CS2 + HLAE MIRV capture",
        "Parse/score work offline; video still requires CS2. A separate demo renderer would be a different product.",
    )

    work_base = app_data_dir()
    try:
        work_base.mkdir(parents=True, exist_ok=True)
        from reel_core.demo.map_assets import prune_preview_junk

        junk = prune_preview_junk()
        free_gb = shutil.disk_usage(work_base).free / (1 << 30)
        disk_detail = f"{free_gb:.1f} GB free at {work_base}"
        if junk.get("freedBytes"):
            disk_detail += f" (cleared {junk['freedBytes'] / (1 << 20):.0f} MB of unused High map dumps)"
        add("Disk space", free_gb > 5, disk_detail)
    except OSError as exc:
        add("Disk space", False, f"cannot create {work_base}: {exc}")

    payload = {
        "ok": all(c["ok"] is not False for c in checks),
        "steamid": steamid,
        "accounts": [
            {
                "steamid": account.steamid,
                "accountName": account.account_name,
                "personaName": account.persona_name,
                "mostRecent": account.most_recent,
                "timestamp": account.timestamp,
            }
            for account in accounts
        ],
        "replaysDir": str(steam.get_replays_dir(cs2_folder)) if cs2_folder else None,
        "cs2Folder": str(cs2_folder) if cs2_folder else None,
        "checks": checks,
    }
    if as_json:
        click.echo(json.dumps(payload, indent=2))
        return

    from rich.table import Table

    table = Table(title="CS2 Reel doctor")
    table.add_column("Check")
    table.add_column("Status")
    table.add_column("Detail")
    for check in checks:
        if check["ok"] is True:
            status = "[green]OK[/green]"
        elif check["ok"] is None:
            status = "[yellow]--[/yellow]"
        else:
            status = "[red]FAIL[/red]"
        detail = check["detail"]
        if check["hint"]:
            detail += f" — {check['hint']}"
        table.add_row(check["name"], status, detail)
    console.print(table)


@main.command(name="update-tools")
@click.option("--json", "as_json", is_flag=True)
def update_tools(as_json: bool) -> None:
    """Download latest HLAE, FFmpeg and CSDM server.dll."""
    from reel_core.recording import toolchain

    hlae = toolchain.install_hlae()
    ffmpeg = toolchain.install_ffmpeg()
    plugin = toolchain.install_plugin_dll()
    try:
        source2viewer = toolchain.install_source2viewer()
    except Exception as exc:
        source2viewer = None
        info(f"Source2Viewer-CLI skipped: {exc}")
    toolchain.write_ffmpeg_ini(hlae, ffmpeg)
    payload = {
        "ok": True,
        "hlae": str(hlae),
        "ffmpeg": str(ffmpeg),
        "plugin": str(plugin) if plugin else None,
        "source2viewer": str(source2viewer) if source2viewer else None,
    }
    if as_json:
        click.echo(json.dumps(payload, indent=2))
        return
    console.print("[green]Tools updated.[/green] Run `reel-core doctor` to verify.")


@main.command()
@click.option("--json", "as_json", is_flag=True)
def detect_steamid(as_json: bool) -> None:
    """Print the most-recent SteamID64 from loginusers.vdf."""
    from reel_core.recording.steam import detect_steamid64, list_steam_accounts

    steamid = detect_steamid64()
    payload = {
        "steamid": steamid,
        "accounts": [
            {
                "steamid": account.steamid,
                "accountName": account.account_name,
                "personaName": account.persona_name,
                "mostRecent": account.most_recent,
                "timestamp": account.timestamp,
            }
            for account in list_steam_accounts()
        ],
    }
    if as_json:
        click.echo(json.dumps(payload))
    elif steamid:
        click.echo(steamid)
    else:
        raise click.ClickException("Could not detect SteamID64")


@main.command()
@click.argument("demo", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option("--player", default=None, help="SteamID64 or player name (your POV)")
@click.option("--all-players", "all_players", is_flag=True, help="Score every player; UI picks POV after")
@click.option("--json", "as_json", is_flag=True, help="Print the UI payload")
@click.option("-o", "--output", type=click.Path(path_type=Path), default=None)
def parse(demo: Path, player: str | None, all_players: bool, as_json: bool, output: Path | None) -> None:
    """Parse DEMO and score personal highlight moments."""
    config = load_config()
    if player is None and not all_players and config.paths.steam_id not in ("", "auto"):
        player = config.paths.steam_id
    with console.status("Parsing demo..."):
        demo_path, parsed = _load_and_parse(demo, config)
        parsed.path = demo_path

    player_steamid = None if all_players else _resolve_cli_player(parsed, player)

    moments, sequences, stats = analyze(parsed, config, player_steamid)
    payload = parse_payload(parsed, moments, sequences, stats, player_steamid)

    if output:
        output.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    if as_json or output:
        if as_json:
            click.echo(json.dumps(payload, indent=2))
        elif output:
            info(f"Wrote {output}")
        return

    info(
        f"{parsed.map_name}  {len(parsed.rounds)} rounds  "
        f"{payload['highlightCount']} moments"
        + (f"  you={payload['you']['name']} {payload['you']['rating']} rating" if payload.get("you") else "")
    )
    for moment in moments[:15]:
        info(
            f"  R{moment.round_index + 1:>2}  {moment.score:5.1f}  "
            f"{moment.name:16}  {' '.join(moment.labels) or moment.describe()}"
        )


@main.command()
@click.argument("demo", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option("--tick", type=int, required=True)
@click.option("--player", default=None, help="SteamID64 to lock POV")
@click.option("--json", "as_json", is_flag=True)
def watch(demo: Path, tick: int, player: str | None, as_json: bool) -> None:
    """Launch CS2 at TICK, or print console commands if launch is not possible."""
    from reel_core.recording.watch import launch_watch

    config = load_config()
    work_dir = _work_dir(config, demo)
    work_dir.mkdir(parents=True, exist_ok=True)
    demo_path = ensure_dem_file(demo, work_dir)
    result = launch_watch(demo_path, tick, player)
    if as_json:
        click.echo(json.dumps(result, indent=2))
        return
    info("Console: " + result["copyText"])
    if result["launched"]:
        info("Launched CS2 via Steam.")
    elif result.get("error"):
        raise click.ClickException(result["error"] + " — paste the commands into the in-game console.")


@main.command()
@click.argument("demo", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option("--moments", "moments_file", type=click.Path(exists=True, path_type=Path), required=True)
@click.option("--out", "out_dir", type=click.Path(path_type=Path), required=True)
@click.option("--player", default=None)
@click.option("--json", "as_json", is_flag=True)
def record(demo: Path, moments_file: Path, out_dir: Path, player: str | None, as_json: bool) -> None:
    """Record selected moments to named MP4s via HLAE."""
    from reel_core.recording.recorder import RecordingSetupError, record as run_record, resolve_tools
    from reel_core.serialize import load_moments_file
    from reel_core.video.postprocess import process_clip

    config = load_config()
    work_dir = _work_dir(config, demo)
    work_dir.mkdir(parents=True, exist_ok=True)
    demo_path, parsed = _load_and_parse(demo, config)
    parsed.path = demo_path

    player_steamid = _resolve_cli_player(parsed, player)

    _, sequences, _ = analyze(parsed, config, player_steamid)
    selected = load_moments_file(moments_file)
    ids = {
        item.get("id") or f"{item.get('steamid')}-{item.get('roundIndex', item.get('round', 1) - 1)}-{item.get('firstTick')}"
        for item in selected
        if isinstance(item, dict)
    }
    if ids:
        filtered = []
        for sequence in sequences:
            keep = any(
                f"{m.steamid}-{m.round_index}-{m.first_tick}" in ids
                or str(sequence.number) in ids
                for m in sequence.moments
            )
            if keep:
                filtered.append(sequence)
        # Direct tick ranges from the UI (queued clips).
        if not filtered:
            filtered = _sequences_from_payload(selected, parsed, player_steamid)
        sequences = filtered

    if not sequences:
        raise click.ClickException("No sequences to record — check the moments file")

    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        outputs = run_record(parsed, sequences, config, work_dir)
    except RecordingSetupError as exc:
        raise click.ClickException(str(exc))

    tools = resolve_tools(config, auto_install=False)
    clips = []
    for output in outputs:
        dest = process_clip(tools.ffmpeg_exe, output, out_dir, output.sequence.filename)
        clips.append(str(dest))

    payload = {"clips": clips, "count": len(clips), "outDir": str(out_dir)}
    if as_json:
        click.echo(json.dumps(payload, indent=2))
    else:
        info(f"Recorded {len(clips)} clip(s) to {out_dir}")


@main.command()
@click.argument("demo", type=click.Path(exists=True, dir_okay=False, path_type=Path))
@click.option("--start", "start_tick", type=int, required=True)
@click.option("--end", "end_tick", type=int, required=True)
@click.option("--player", required=True, help="SteamID64 POV")
@click.option("--map-name", default="")
@click.option("--tickrate", type=float, default=0.0)
@click.option("--json", "as_json", is_flag=True)
def preview(
    demo: Path,
    start_tick: int,
    end_tick: int,
    player: str,
    map_name: str,
    tickrate: float,
    as_json: bool,
) -> None:
    """Dump clip poses for the in-app 3D Preview tab (does not launch CS2)."""
    from reel_core.demo.parser import DEFAULT_TICKRATE
    from reel_core.demo.trajectory import dump_clip_trajectory

    payload = dump_clip_trajectory(
        demo,
        start_tick=start_tick,
        end_tick=end_tick,
        pov_steamid=player,
        map_name=map_name,
        tickrate=tickrate or DEFAULT_TICKRATE,
    )
    if as_json:
        click.echo(
            json.dumps(
                {
                    "ok": True,
                    "cachePath": payload["cachePath"],
                    "map": payload["map"],
                    "frames": len(payload["frames"]),
                    "mapSource": payload["mapSource"],
                }
            )
        )
        return
    info(
        f"Preview {payload['map']}  {len(payload['frames'])} frames  "
        f"map={payload['mapSource']}  pov={payload['povSteamid']}"
    )


@main.command(name="preview-map")
@click.argument("map_name")
@click.option("--quality", type=click.Choice(["low", "medium", "high"]), default="low")
@click.option("--json", "as_json", is_flag=True)
def preview_map(map_name: str, quality: str, as_json: bool) -> None:
    """Export a local CS2 map mesh for Preview (Source2Viewer CLI, cached)."""
    from reel_core.demo.map_assets import export_map_preview, map_is_installed, resolve_map_stem

    stem = resolve_map_stem(map_name)
    payload = export_map_preview(stem, quality=quality)
    payload["mapInstalled"] = map_is_installed(stem)
    if as_json:
        click.echo(json.dumps(payload))
        return
    info(f"Map {map_name}  quality={quality}  source={payload.get('mapSource')}  {payload.get('mapGltf')}")


@main.command(name="preview-assets")
@click.option("--spec", "spec_path", type=click.Path(exists=True, dir_okay=False))
@click.option("--warm", is_flag=True, help="Prefetch every gun GLB plus SAS/Phoenix locomotion.")
@click.option("--skins-all", "skins_all", is_flag=True, help="Bake every paint kit at 64px into AppData.")
@click.option("--json", "as_json", is_flag=True)
def preview_assets(spec_path: str | None, warm: bool, skins_all: bool, as_json: bool) -> None:
    """Export local CS2 weapon and agent models for Preview (cached).

    The spec is read from a file rather than the command line because the
    animation list runs to dozens of long paths. It is built by the renderer,
    which owns the weapon table and therefore the animation names.
    """
    from reel_core.demo.game_assets import export_assets

    spec: dict = {}
    if spec_path:
        try:
            loaded = json.loads(Path(spec_path).read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            payload = {"ok": False, "error": f"unreadable spec: {exc}"}
            if as_json:
                click.echo(json.dumps(payload))
                return
            raise click.ClickException(payload["error"]) from exc
        spec = loaded if isinstance(loaded, dict) else {}
    elif not warm and not skins_all:
        raise click.UsageError("Provide --spec, --warm or --skins-all")
    if warm:
        spec["warm"] = True
    if skins_all:
        spec["skinsAll"] = True
    payload = export_assets(spec)

    if as_json:
        click.echo(json.dumps(payload))
        return
    info(
        f"Assets  weapons={len(payload.get('weapons') or {})}  "
        f"agents={len(payload.get('agents') or {})}  "
        f"missing={payload.get('weaponsMissing') or []}  "
        f"skins={len(payload.get('skins') or {})}"
    )


@main.command(name="preview-audit-poses")
@click.option("--spec", "spec_path", required=True, type=click.Path(exists=True, dir_okay=False))
@click.option("--json", "as_json", is_flag=True)
def preview_audit_poses(spec_path: str, as_json: bool) -> None:
    """Check weapon-table viewmodel pose names against pak01."""
    from reel_core.demo.pose_audit import audit_viewmodel_poses

    try:
        spec = json.loads(Path(spec_path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        payload = {"ok": False, "error": f"unreadable spec: {exc}"}
    else:
        poses = spec.get("poses") if isinstance(spec, dict) else spec
        payload = audit_viewmodel_poses(list(poses or []))

    if as_json:
        click.echo(json.dumps(payload))
        return
    missing = payload.get("missing") or []
    info(f"Pose audit  listed={payload.get('listed', 0)}  missing={len(missing)}")
    for name in missing[:40]:
        info(f"  missing {name}")


def _sequences_from_payload(items: list[dict], demo: DemoData, player_steamid: str | None) -> list[Sequence]:
    sequences: list[Sequence] = []
    for i, item in enumerate(items, start=1):
        start = int(item.get("startTick") or item.get("firstTick") or 0)
        end = int(item.get("endTick") or item.get("lastTick") or 0)
        steamid = str(item.get("steamid") or player_steamid or "")
        if start <= 0 or end <= start or not steamid:
            continue
        sequences.append(
            Sequence(
                number=i,
                start_tick=start,
                end_tick=end,
                cameras=[CameraAction(tick=start, steamid=steamid)],
                label=item.get("label") or f"clip {i}",
                score=float(item.get("score") or 0),
                round_index=int(item.get("roundIndex") or max(int(item.get("round", 1)) - 1, 0)),
                filename=item.get("filename") or f"{i:02d}_clip.mp4",
            )
        )
    return sequences


if __name__ == "__main__":
    main()
