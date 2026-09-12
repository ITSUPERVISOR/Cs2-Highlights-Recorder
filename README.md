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
