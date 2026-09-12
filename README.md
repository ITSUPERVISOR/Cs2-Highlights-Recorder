# Reel

Windows desktop app for managing CS2 demos, scoring *your* rounds, previewing clips in 3D, and recording them with HLAE.

## Core (Python)

```powershell
cd core
python -m venv .venv
.\.venv\Scripts\pip install -e ".[dev]"
.\.venv\Scripts\reel-core doctor
.\.venv\Scripts\reel-core parse path\to\match.dem --player <steamid64> --json
```

`update-tools` downloads current HLAE, FFmpeg, and CS Demo Manager’s MIT `server.dll` from GitHub.

## UI (Electron)

```powershell
npm install
npm run dev
```

First launch: open **Doctor**, confirm SteamID, **Scan folders**, click a demo to parse.

## Preview

**Preview** replays a waiting clip in-app as a pose dump — not HLAE, and not a video file. Scrubbing is playhead-pure: guns, nades, flashes, planted/dropped C4, and death falls follow the demo tick.

It reads models from your local CS2 install (Source2Viewer → `%LOCALAPPDATA%\cs2-reel\`). Collision hulls stay untextured. Weapon skins are 64px nearest albedos, never native 4K.

On Doctor, **Cache Preview weapons** warms the gun/agent GLBs so the first clip is not a cold export. Missing maps fall back to a flat ground plane.

## Recording

Clip video still requires CS2 + HLAE (not a no-game renderer). **MIRV** (`mirv_streams`) is HLAE’s in-game capture: Reel injects those commands while CS2 plays the demo.

HLAE must match your CS2 build. Doctor only shows **Update** when GitHub has a *newer* HLAE zip than the one you already have. If you are already on the latest HLAE and CS2 is newer, wait for [advancedfx releases](https://github.com/advancedfx/advancedfx/releases) — use **Watch** + OBS in the meantime. Record is still allowed and may crash.

By default Record runs **unattended**: the game window stays on screen in the background — do not minimize it. Parse, scoring, and Preview do not need the game open.
