import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, nodeId, signature, type RawGraph } from "../src/snapshot";
import { autoSpeed, jitter, sequence } from "../src/sequence";
import { makeGraph, rng } from "./helpers";

const stats = { notes: 0, links: 0, orphans: 0, unresolved: 0 };

/** Same graph, notes shuffled locally: what a fresh Obsidian layout does. */
function relayout(g: RawGraph, seed: number, amount = 150): RawGraph {
	const r = rng(seed);
	return { ...g, nodes: g.nodes.map((n) => ({ ...n, x: n.x + (r() - 0.5) * amount, y: n.y + (r() - 0.5) * amount })) };
}

test("signature ignores layout but sees notes and links", () => {
	const g = makeGraph(60);
	const a = buildSnapshot("2026-11-08", g, null, stats, false);
	const b = buildSnapshot("2026-11-09", relayout(g, 5), a, stats, false);
	assert.equal(signature(a), signature(b));
	const g2 = { ...g, links: [...g.links, ["note-3.md", "note-50.md"] as [string, string]] };
	assert.notEqual(signature(a), signature(buildSnapshot("2026-11-10", g2, b, stats, false)));
});

test("unchanged snapshots fold into one frame with the latest date", () => {
	const g = makeGraph(60);
	const a = buildSnapshot("2026-11-08", g, null, stats, false);
	const b = buildSnapshot("2026-11-09", relayout(g, 2), a, stats, false);
	const c = buildSnapshot("2026-11-10", relayout(g, 3), b, stats, false);
	const frames = sequence([a, b, c], { skipUnchanged: true, steady: 0 });
	assert.equal(frames.length, 1);
	assert.ok(frames[0].label.startsWith("2026-11-10"));
	assert.equal(sequence([a, b, c], { skipUnchanged: false, steady: 0 }).length, 3);
});

test("steady layout cuts jumping between re-layouts", () => {
	let g = makeGraph(200);
	const snaps = [];
	let prev = null;
	for (let d = 0; d < 12; d++) {
		g = { ...g, nodes: [...g.nodes, { path: `new-${d}.md`, x: 0, y: 0, r: 8, color: "#b3b3b3ff" }], links: [...g.links, [`new-${d}.md`, `note-${d}.md`] as [string, string]] };
		const s = buildSnapshot(`2026-11-${String(d + 1).padStart(2, "0")}`, relayout(g, d + 10, 400), prev, stats, false);
		snaps.push(s);
		prev = s;
	}
	const raw = jitter(sequence(snaps, { skipUnchanged: false, steady: 0 }));
	const steady = jitter(sequence(snaps, { skipUnchanged: false, steady: 0.7 }));
	assert.ok(steady < raw * 0.5, `raw ${raw.toFixed(2)}% vs steady ${steady.toFixed(2)}%`);
});

test("a new note appears beside the note it links to", () => {
	const g = makeGraph(80);
	const a = buildSnapshot("2026-11-08", g, null, stats, false);
	const g2 = relayout({ ...g, nodes: [...g.nodes, { path: "fresh.md", x: 0, y: 0, r: 8, color: "#b3b3b3ff" }], links: [...g.links, ["fresh.md", "note-10.md"] as [string, string]] }, 9, 600);
	// Place "fresh" 20 units from note-10 in the new layout.
	const ten = g2.nodes.find((n) => n.path === "note-10.md")!;
	g2.nodes[g2.nodes.length - 1] = { ...g2.nodes[g2.nodes.length - 1], x: ten.x + 20, y: ten.y };
	const b = buildSnapshot("2026-11-09", g2, a, stats, false);
	const [, f] = sequence([a, b], { skipUnchanged: false, steady: 0.9 });
	const freshId = nodeId("fresh.md");
	const tenId = nodeId("note-10.md");
	const p = f.nodes.get(freshId)!;
	const q = f.nodes.get(tenId)!;
	assert.ok(Math.hypot(p.x - q.x, p.y - q.y) < 40, `distance ${Math.hypot(p.x - q.x, p.y - q.y)}`);
});

test("auto speed: slow for short histories, capped for long ones", () => {
	assert.equal(autoSpeed(5), 1); // a few snapshots: 1 per second
	assert.equal(autoSpeed(61), 4); // two months: ~15 s
	assert.equal(autoSpeed(366), 8); // a year: capped, ~45 s
	assert.equal(autoSpeed(1), 1);
});
