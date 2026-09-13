# CS2 Reel core

Python CLI that parses CS2 demos, scores *your* rounds, dumps in-app Preview poses, and records clips through HLAE.

```
reel-core doctor
reel-core parse match.dem --player <steamid64> --json
reel-core watch match.dem --tick 12345 --player <steamid64>
reel-core record match.dem --moments moments.json --out ./clips
reel-core preview match.dem --start 1000 --end 2000 --player <steamid64>
reel-core preview-map de_inferno
reel-core preview-assets --warm
reel-core update-tools
```

HLAE, FFmpeg and CS Demo Manager's MIT `server.dll` are fetched from current GitHub releases — not carved out of an installer.

## Preview notes

- Pose dumps, collision hulls, radar overlays, and weapon/agent GLBs go under `%LOCALAPPDATA%\cs2-reel\`. Nothing from the CS2 VPK is committed.
- Preview qualities: **Low** collision hull, **Medium / High** hull + local radar tint. High does not export the Source 2 world mesh (too large for WebGL). `preview-map MAP --quality low|medium|high`. Unused `maps/*/high` world dumps are pruned on export.
- `--warm` prefetches every gun mesh plus SAS/Phoenix locomotion. `--skins-all` bakes paint kits at 64px (never 4K).
- A map that is not in the install gets a flat fallback, not a silent empty scene.

## Recording notes

- **Parse / score / Preview** work fully offline (no CS2 client). Preview still needs the local CS2 *files* for maps and models.
- **Record** always launches a real CS2 client via HLAE + MIRV. There is no headless / no-CS2 video path in this repo.
- Default **`[recording] unattended = true`** (in `%LOCALAPPDATA%\cs2-reel\config.toml`) sinks the CS2 window behind other apps but **keeps it visible**. Do not minimize — MIRV often records black frames when the window is minimized or fully covered.
- Set `unattended = false` if you want the old “keep CS2 focused” behaviour.
- **HLAE vs CS2:** Doctor compares your HLAE zip to GitHub. Update only appears when a newer HLAE exists. If CS2 is newer than the newest HLAE, use Watch + OBS; this repo cannot patch AfxHookSource2.
