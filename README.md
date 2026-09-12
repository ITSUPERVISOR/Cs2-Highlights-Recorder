# Reel

Windows desktop app for managing CS2 demos, scoring *your* rounds, and recording clips.

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

## Recording

Clip video still requires CS2 + HLAE (not a no-game renderer). **MIRV** (`mirv_streams`) is HLAE’s in-game capture: Reel injects those commands while CS2 plays the demo.

HLAE must match your CS2 build. Doctor only shows **Update** when GitHub has a *newer* HLAE zip than the one you already have. If you are already on the latest HLAE and CS2 is newer, wait for [advancedfx releases](https://github.com/advancedfx/advancedfx/releases) — use **Watch** + OBS in the meantime. Record is still allowed and may crash.

By default Record runs **unattended**: the game window stays on screen in the background — do not minimize it. Parse and scoring do not need the game open.
