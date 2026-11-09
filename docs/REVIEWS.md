# Reviews

Outside reviews of Graph Timelapse, what they found, and what changed because of them.

## 1 · ChatGPT code and product review — 2026-11-08 (v0.2.0)

**Asked:** what the repo is for, whether it solves the problem well, code quality, bulk vs. efficiency, with evidence. And: should you buy them a coffee?

**Verdict: 8.2 / 10.** Small, focused software with a sensible architecture and controlled scope that solves a real problem in an interesting way; not perfect, but worth maintaining rather than rewriting. Coffee: **yes**.

### Scores

| Category | Score |
|---|---|
| Originality of idea | 9 |
| Problem identification | 9 |
| Architecture | 8.5 |
| Code organisation | 8.5 |
| Storage efficiency | 9 |
| Runtime efficiency | 7.5 |
| Error handling | 8.5 |
| Maintainability | 8 |
| Compatibility strategy | 6.5 |
| Test coverage evidence | 4 |

### What it praised

- **The idea:** a real historical record of the graph, instead of replaying file dates like Obsidian's built-in Animate. In effect, a time-series visualisation engine for a knowledge graph.
- **Procrustes alignment** for Obsidian's re-randomised layouts: called out as solving the actual problem rather than just the obvious feature, and the clearest sign of real thought in the project.
- **Data-first architecture:** store the graph data and render from it, rather than keeping screenshots. Judged the right architecture for this problem.
- **Separation of concerns** across `main`, `capture`, `snapshot`, `render`, `embed`, `settings`.
- **Deliberate error handling:** capture fallbacks, and the renderer's transform restored in a `finally` block.
- **Snapshot format:** one node or link per line for readable diffs and compression; palette indexes instead of repeated colours.
- **Lean dependencies:** no frameworks or runtime libraries; just the platform.
- Local-first, no services, no subscription, privacy-conscious defaults, MIT.
- No rewrite recommended: the improvements are targeted refinements.

### What it criticised, and what we did

| Finding | Priority | Response |
|---|---|---|
| No automated tests, especially for alignment | High | **Fixed in 0.2.1.** 13 tests (`npm test`). They found a real gap: duplicate links weren't removed at snapshot time. |
| Depends on Obsidian internals | High | **Ongoing.** Typed, guarded access in `src/internals.ts`; image fallback; `last-capture.json`. Test against each new Obsidian release before claiming compatibility. |
| `mode: once` keeps redrawing after finishing | Medium | **Fixed in 0.2.1.** |
| Interpolation rebuilds Maps/Sets every frame | Medium | **Fixed in 0.2.1.** Transitions are precomputed; frames update in place. |
| Snapshot cache has no eviction | Medium | **Fixed in 0.2.1.** LRU, 150 snapshots. |
| "Anonymous ids" overstates privacy | Low | **Fixed in 0.2.1.** Now "pseudonymous"; README explains the limit. |
| Renamed notes look like delete + add | Low | **Documented** as a known limitation. Possible later: match renames by link neighbourhood. |
| Rigid alignment can't hide cluster rearrangement | — | **Documented.** Accepted trade-off; the reviewer called it a sensible compromise. |
| Recording briefly opens a graph tab | — | **Documented.** Possible later: wait until the user is idle. |

Source: shared ChatGPT conversation "Review Graph Timelapse Repo", 2026-11-08.
