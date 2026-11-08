# Changelog

## 0.2.0 — 2026-11-08 · Initial release

First public version of Graph Timelapse: a recorded history of your Obsidian graph, played back as a timelapse in any note.

### What it does
- **Records the real graph.** On a schedule (default daily, configurable from 30 minutes to years) it briefly opens the graph view and saves every note's position, size and colour, plus every link, as a small JSON snapshot in `_attachments/graph-data/`.
- **Keeps the layout steady.** Each snapshot is rotated, mirrored or shifted to best match the previous one, so notes stay put and new ones appear.
- **Plays it back anywhere.** A `graph-timelapse` code block embeds an animated timelapse in any note: notes glide, new ones fade in, removed ones fade out. Click to pause. Modes: `loop`, `once`, `still`.
- **Saves PNG keyframes** (default weekly), drawn from the data so they're crisp at any size. **Render PNG from a snapshot** draws any saved day.
- **Counts growth.** Each image is stamped with notes, links, orphans and unresolved links; the same counts go to a CSV, one row per day.
- **Private by default.** Notes are stored as anonymous ids unless *Store note titles* is on. No network access.
- **Fails safe.** If Obsidian's graph internals change, it falls back to an image capture and logs what happened to `last-capture.json`.

### Built along the way (0.1.x, unreleased)
- 0.1.0: daily PNG of the graph view via Obsidian's PIXI renderer.
- Fixed: graph drawn tiny and in a corner (the view's zoom was applied to the render but not to the size maths).
- Fixed: pixelated output (the stage is ~10× larger than the graph; now only the graph's region is rendered).
- Added shape presets (square 1080 default, 4:5, 9:16, 16:9) and a build stamp in the debug log.
