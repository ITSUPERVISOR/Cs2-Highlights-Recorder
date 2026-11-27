# Reel

Native preview for CS2 demos. It parses a match, lists the highlight clips, and plays the poses in a window. Recording with HLAE is still the Python tool in `core/`.

## Preview

```bash
cd native
cargo build --release
./target/release/reel play path/to/match.dem
./target/release/reel bench path/to/match.dem
```

`play` opens the window on the busiest clip. The list on the left switches highlights. Pause and the slider scrub the tick. Players are colored bodies, shots are short lines, and grenade flights are paths. There is no CS2 install required for this view, so the floor is the bounds of the poses rather than the map mesh.

On the Inferno demo used for the comparison, the Rust engine and the Python engine agreed: 23 rounds, 175 kills, CT 10–T 13, and Fifou's round-11 4K at 812 frames, 80 shots, and 7 grenades. Rust was faster (parse 0.44s against 1.73s, first preview 0.91s against 3.23s), so the window calls the Rust engine directly.

## Recording

Clip video still needs CS2 and HLAE. That path stays in Python:

```bash
cd core
python -m reel_core doctor
python -m reel_core record path/to/match.dem --moments moments.json --out clips/
```
