import { test } from "node:test";
import assert from "node:assert/strict";
import { Transition, frameOf } from "../src/render";
import { buildSnapshot } from "../src/snapshot";
import { makeGraph } from "./helpers";

const stats = { notes: 0, links: 0, orphans: 0, unresolved: 0 };

function pair() {
	const g = makeGraph(40);
	const a = buildSnapshot("2026-11-08", g, null, stats, false);
	const g2 = { ...g, nodes: g.nodes.slice(5).map((n) => ({ ...n, x: n.x + 50 })), links: g.links.slice(5) };
	g2.nodes.push({ path: "added.md", x: 0, y: 0, r: 9, color: "#b3b3b3ff" });
	g2.links.push(["added.md", "note-6.md"]);
	const b = buildSnapshot("2026-11-09", g2, a, stats, false);
	return { A: frameOf(a), B: frameOf(b) };
}

test("transition starts at A and ends at B", () => {
	const { A, B } = pair();
	const tr = new Transition(A, B);
	const f0 = tr.at(0);
	for (const [id, n] of A.nodes) {
		assert.ok(Math.abs(f0.nodes.get(id)!.x - n.x) < 1e-9);
		assert.equal(f0.nodes.get(id)!.alpha, 1);
	}
	const f1 = tr.at(1);
	for (const [id, n] of B.nodes) {
		assert.ok(Math.abs(f1.nodes.get(id)!.x - n.x) < 1e-9);
		assert.equal(f1.nodes.get(id)!.alpha, 1);
	}
});

test("removed notes fade out, added notes fade in", () => {
	const { A, B } = pair();
	const tr = new Transition(A, B);
	const removed = [...A.nodes.keys()].filter((id) => !B.nodes.has(id));
	const added = [...B.nodes.keys()].filter((id) => !A.nodes.has(id));
	assert.equal(removed.length, 5);
	assert.equal(added.length, 1);
	const end = tr.at(1);
	for (const id of removed) assert.equal(end.nodes.get(id)!.alpha, 0);
	const start = tr.at(0);
	for (const id of added) assert.equal(start.nodes.get(id)!.alpha, 0);
});

test("links that come and go fade with the transition", () => {
	const { A, B } = pair();
	const tr = new Transition(A, B);
	const key = (l: { a: string; b: string }) => l.a + "|" + l.b;
	const inA = new Set(A.links.map(key));
	const inB = new Set(B.links.map(key));
	const mid = tr.at(0.5);
	for (const l of mid.links) {
		if (inA.has(key(l)) && inB.has(key(l))) assert.equal(l.alpha, 1);
		else assert.ok(l.alpha > 0 && l.alpha < 1);
	}
});

test("frames are updated in place, not rebuilt", () => {
	const { A, B } = pair();
	const tr = new Transition(A, B);
	const f1 = tr.at(0.2);
	const nodes1 = f1.nodes;
	const f2 = tr.at(0.8);
	assert.equal(f1, f2);
	assert.equal(nodes1, f2.nodes);
});

test("draw order puts the biggest notes last", () => {
	const { A } = pair();
	const r = A.order.map((n) => n.r);
	assert.deepEqual(r, [...r].sort((p, q) => p - q));
});
