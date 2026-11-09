# Changelog

## 0.2.1 — 2026-11-08 · First review fixes

Changes from the first outside review ([docs/REVIEWS.md](docs/REVIEWS.md)).

### Fixed
- **`mode: once` kept redrawing after it finished.** The animation now stops requesting frames at the last frame. Clicking it plays it again.
- **Duplicate links could reach a snapshot** if the same pair arrived twice (found by the new tests). Snapshots now keep one link per pair of notes.

### Faster
- **Playback no longer rebuilds the graph every frame.** Each change between two snapshots is worked out once and reused; frames only update numbers in place. Draw order and theme colours are also computed once instead of per frame.
- **Snapshot cache is bounded** to the 150 most recently used snapshots.

### Safer
- **Corrupted or unknown snapshot files are skipped** instead of breaking playback (shape and version check on load).

### Clearer
- Privacy wording: note ids are **pseudonymous** (path hashes), not anonymous. Settings, README and code comments say so.
- README lists known limitations: renames, rigid alignment, image-fallback days.

### Added
- **Automated tests** (`npm test`, Node's built-in runner): alignment with rotated, mirrored and changing graphs; titles stored only when asked; link de-duplication; serialization round trip; corrupt-file rejection; transitions start at A and end at B, fades, in-place updates, draw order.


## 0.2.0 — 2026-11-08 · Initial release

First public version of Graph Timelapse: a recorded history of your Obsidian graph, played back as a timelapse in any note.

### What it does
- **Records the real graph.** On a schedule (default daily, configurable from 30 minutes to years) it briefly opens the graph view and saves every note's position, size and colour, plus every link, as a small JSON snapshot in `_attachments/graph-data/`.
- **Keeps the layout steady.** Each snapshot is rotated, mirrored or shifted to best match the previous one, so notes stay put and new ones appear.
- **Plays it back anywhere.** A `graph-timelapse` code block embeds an animated timelapse in any note: notes glide, new ones fade in, removed ones fade out. Click to pause. Modes: `loop`, `once`, `still`.
- **Saves PNG keyframes** (default weekly), drawn from the data so they're crisp at any size. **Render PNG from a snapshot** draws any saved day.
- **Counts growth.** Each image is stamped with notes, links, orphans and unresolved links; the same counts go to a CSV, one row per day.
- **Private by default.** Notes are stored as pseudonymous ids unless *Store note titles* is on. No network access.
- **Fails safe.** If Obsidian's graph internals change, it falls back to an image capture and logs what happened to `last-capture.json`.

### Built along the way (0.1.x, unreleased)
- 0.1.0: daily PNG of the graph view via Obsidian's PIXI renderer.
- Fixed: graph drawn tiny and in a corner (the view's zoom was applied to the render but not to the size maths).
- Fixed: pixelated output (the stage is ~10× larger than the graph; now only the graph's region is rendered).
- Added shape presets (square 1080 default, 4:5, 9:16, 16:9) and a build stamp in the debug log.
