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
