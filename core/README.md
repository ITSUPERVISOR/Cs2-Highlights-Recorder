# CS2 Reel core

Python CLI that parses CS2 demos, scores *your* rounds, and records clips through HLAE.

```
reel-core doctor
reel-core parse match.dem --player <steamid64> --json
reel-core watch match.dem --tick 12345 --player <steamid64>
reel-core record match.dem --moments moments.json --out ./clips
reel-core update-tools
```

HLAE, FFmpeg and CS Demo Manager's MIT `server.dll` are fetched from current GitHub releases — not carved out of an installer.

## Recording notes

- **Parse / score** work fully offline (no CS2).
- **Record** always launches a real CS2 client via HLAE + MIRV. There is no headless / no-CS2 video path in this repo.
- Default **`[recording] unattended = true`** (in `%LOCALAPPDATA%\cs2-reel\config.toml`) sinks the CS2 window behind other apps but **keeps it visible**. Do not minimize — MIRV often records black frames when the window is minimized or fully covered.
- Set `unattended = false` if you want the old “keep CS2 focused” behaviour.
- **HLAE vs CS2:** Doctor compares your HLAE zip to GitHub. Update only appears when a newer HLAE exists. If CS2 is newer than the newest HLAE, use Watch + OBS; this repo cannot patch AfxHookSource2.
