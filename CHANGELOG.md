# Changelog

## 0.3.0 — 2026-11-09 · Video export and steady playback

### Added
- **Export timelapse video** command: MP4 (or WebM) of any date range, in any of the image shapes, with speed and hold controls. Saved next to the PNG keyframes.
  - WebCodecs encoding with exact frame timestamps (via [Mediabunny](https://mediabunny.dev), MPL-2.0): smooth at 10,000 notes and faster than real time for typical vaults. MediaRecorder fallback where WebCodecs is missing; MP4 falls back to WebM (and back) if a format can't be encoded.
  - Every export includes a small "made with Graph Timelapse" credit.
  - Snapshots are streamed two at a time and kept out of the playback cache, so long histories don't fill memory.
- **Stress-test data generator** (`npm run bench:gen`, see `bench/README.md`): simulated vaults from 100 to 10,000+ notes with hundreds of days of history, written through the real snapshot code.

- **Steady playback** for embeds and exports: notes keep close to where they were between snapshots (Obsidian re-lays out the graph every capture), new notes appear beside the notes they link to. `steady: 0…0.95` in embeds (default 0.7), slider in the export dialog. Recorded data is unchanged.
- **Auto speed** (new default for embeds and exports): aims for a ~15 s timelapse, at 1 to 8 snapshots per second. Set `speed:` or pick a speed in the export dialog to override.
- **Skip unchanged snapshots**: snapshots with the same notes and links as the one before are folded into it (`skip-unchanged: false` to turn off).
- `npm run bench:jitter -- <graph-data folder>`: measures how much a timelapse jumps around. The generator now mimics Obsidian's re-layouts and reports jitter before/after.

### Fixed
- **Captures of an unfinished layout.** The settle check counted a layout that hadn't started moving as "settled", so captures taken while Obsidian was in the background could record a half-done, squeezed layout (about 1 in 4 on a real vault). It now waits until it has seen the layout move and then come to rest, and automatic captures where the layout never ran are retried at the next check (after three tries it records anyway). Settle details are written to `last-capture.json`.

### Notes
- The renderer can draw a credit line; PNG keyframes are unchanged.
- README: demo GIF and sample videos in `docs/media/`.

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
