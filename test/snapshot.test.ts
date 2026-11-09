import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, isSnapshot, nodeId, serialize, type Snapshot } from "../src/snapshot";
import { makeGraph, transform } from "./helpers";

const stats = { notes: 0, links: 0, orphans: 0, unresolved: 0 };

/** Mean distance between the same note in two snapshots. */
function drift(a: Snapshot, b: Snapshot): number {
	const pa = new Map(a.nodes.map((n) => [n[0], n]));
	let sum = 0;
	let count = 0;
	for (const n of b.nodes) {
		const p = pa.get(n[0]);
		if (!p) continue;
		sum += Math.hypot(p[1] - n[1], p[2] - n[2]);
		count++;
	}
	return sum / count;
}

test("alignment undoes a rotation and shift", () => {
	const g = makeGraph(150);
	const day1 = buildSnapshot("2026-11-08", g, null, stats, false);
	const day2 = buildSnapshot("2026-11-09", transform(g, 73, false, 500, -200), day1, stats, false);
	assert.ok(drift(day1, day2) < 0.1, `drift ${drift(day1, day2)}`);
});

test("alignment undoes a mirrored layout", () => {
	const g = makeGraph(150, 7);
	const day1 = buildSnapshot("2026-11-08", g, null, stats, false);
	const day2 = buildSnapshot("2026-11-09", transform(g, 200, true, -300, 40), day1, stats, false);
	assert.ok(drift(day1, day2) < 0.1, `drift ${drift(day1, day2)}`);
});

test("alignment still works when notes are added and removed", () => {
	const g = makeGraph(150, 3);
	const day1 = buildSnapshot("2026-11-08", g, null, stats, false);
	const changed = transform(g, 45, false, 100, 100);
	changed.nodes = changed.nodes.slice(10); // 10 notes deleted
	for (let i = 0; i < 20; i++) changed.nodes.push({ path: `new-${i}.md`, x: i * 13, y: i * -7, r: 8, color: "#b3b3b3ff" }); // 20 added
	const day2 = buildSnapshot("2026-11-09", changed, day1, stats, false);
	assert.equal(day2.nodes.length, 160);
	assert.ok(drift(day1, day2) < 0.1, `drift ${drift(day1, day2)}`);
});

test("first snapshot is centred on the origin", () => {
	const s = buildSnapshot("2026-11-08", transform(makeGraph(50), 0, false, 5000, 5000), null, stats, false);
	const cx = s.nodes.reduce((a, n) => a + n[1], 0) / s.nodes.length;
	const cy = s.nodes.reduce((a, n) => a + n[2], 0) / s.nodes.length;
	assert.ok(Math.abs(cx) < 1 && Math.abs(cy) < 1);
});

test("ids are stable and titles are only stored when asked", () => {
	assert.equal(nodeId("a/b.md"), nodeId("a/b.md"));
	assert.notEqual(nodeId("a/b.md"), nodeId("a/c.md"));
	const g = makeGraph(5);
	const without = buildSnapshot("k", g, null, stats, false);
	const withTitles = buildSnapshot("k", g, null, stats, true);
	assert.ok(without.nodes.every((n) => n.length === 5));
	assert.ok(serialize(without).indexOf("note-") === -1, "paths leaked");
	assert.ok(withTitles.nodes.every((n) => typeof n[5] === "string"));
});

test("links are de-duplicated pairs of node ids", () => {
	const g = makeGraph(20);
	g.links.push([g.links[0][1], g.links[0][0]]); // same link, reversed
	const s = buildSnapshot("k", g, null, stats, false);
	const ids = new Set(s.nodes.map((n) => n[0]));
	assert.equal(s.links.length, 19);
	assert.ok(s.links.every(([a, b]) => a < b && ids.has(a) && ids.has(b)));
});

test("serialize round-trips and puts one node or link per line", () => {
	const s = buildSnapshot("2026-11-08", makeGraph(30), null, stats, false);
	const text = serialize(s);
	const back: unknown = JSON.parse(text);
	assert.ok(isSnapshot(back));
	assert.deepEqual((back as Snapshot).nodes, s.nodes);
	assert.ok(text.split("\n").length > s.nodes.length + s.links.length);
});

test("isSnapshot rejects corrupted or foreign files", () => {
	assert.equal(isSnapshot(null), false);
	assert.equal(isSnapshot({}), false);
	assert.equal(isSnapshot({ v: 1, key: "x", nodes: "nope", links: [], palette: [] }), false);
	assert.equal(isSnapshot({ v: 99, key: "x", nodes: [], links: [], palette: [] }), false, "future version");
	assert.equal(isSnapshot({ v: 1, key: "x", nodes: [["id", "x", 0, 1, 0]], links: [], palette: [] }), false, "bad number");
});
