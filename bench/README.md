# Stress-test sample data

`bench/generate.ts` simulates vaults of different sizes growing over time, and runs every
simulated day through the plugin's real `buildSnapshot()` + `serialize()`. The files are
byte-for-byte what the plugin would write.

```bash
npm install                      # once (esbuild)
npm run bench:gen                # default: 100, 1000, 2500, 5000, 7500, 10000 notes × 300 days
npm run bench:gen -- --tiers 100,1000 --days 30          # quick
npm run bench:gen -- --tiers 15000,20000 --days 365      # go bigger
npm run bench:gen -- --help
```

Each tier becomes `bench/out/vault-<tier>/`, an Obsidian vault with:

- `_attachments/graph-data/*.json`: one snapshot per day, ending **yesterday** (so the plugin's
  first real capture today becomes the newest frame)
- `Topic NNN/Note NNNNNN.md`: the final day's notes with real `[[wikilinks]]` (~2% unresolved,
  ~5% orphans). The paths match the snapshot ids, so a live capture lines up with the fake history
- `Timelapse.md`: a loop embed and a "latest" still
- `.obsidian/plugins/graph-timelapse/`: a copy of the built plugin (run `npm run build` first)

`bench/out/summary.csv` records snapshot size and `buildSnapshot` / `serialize` / parse
timings per tier.

What the simulation models: clustered topics, hub notes (preferential linking), daily
growth from `--start-frac` (default 50%) to the full size, about 0.1% deletes, 0.05% renames, link churn,
small layout drift, and a random rotate/mirror/shift each day, the way Obsidian re-lays out the graph.

**Jumpiness.** The generator mimics Obsidian re-laying out the graph on each capture (clusters shuffle, about 1 in 4 captures is unsettled; `--calm-layout` turns it off). `summary.csv` reports `jitterRawPct` (as recorded) and `jitterSteadyPct` (steady playback + skip unchanged): how far notes move between frames, as % of the frame. To measure a real vault:

```bash
npm run bench:jitter -- "C:/Users/you/Documents/Obsidian/Vault/_attachments/graph-data"
```

Disk: about 90 bytes per note per snapshot (10k notes × 300 days ≈ 200 MB).
Use `--no-notes` to skip the .md files.
