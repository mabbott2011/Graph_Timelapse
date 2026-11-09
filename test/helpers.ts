import type { RawGraph } from "../src/snapshot";

/** Deterministic pseudo-random numbers so test graphs are the same every run. */
export function rng(seed = 1): () => number {
	let s = seed;
	return () => {
		s = (s * 16807) % 2147483647;
		return s / 2147483647;
	};
}

export function makeGraph(n: number, seed = 1): RawGraph {
	const rnd = rng(seed);
	const g: RawGraph = { nodes: [], links: [], line: { color: "#ffffff40", width: 0.5 } };
	for (let i = 0; i < n; i++) {
		g.nodes.push({ path: `note-${i}.md`, x: rnd() * 2000 - 1000, y: rnd() * 2000 - 1000, r: 8 + (i % 5), color: i % 4 ? "#b3b3b3ff" : "#44cf6eff" });
	}
	for (let i = 1; i < n; i++) g.links.push([`note-${i}.md`, `note-${Math.floor(rnd() * i)}.md`]);
	return g;
}

/** Rotate by `deg`, optionally mirror, then shift — what a fresh Obsidian layout can look like. */
export function transform(g: RawGraph, deg: number, mirror: boolean, dx: number, dy: number): RawGraph {
	const t = (deg * Math.PI) / 180;
	const c = Math.cos(t);
	const s = Math.sin(t);
	return {
		...g,
		nodes: g.nodes.map((n) => {
			const x = mirror ? -n.x : n.x;
			return { ...n, x: x * c - n.y * s + dx, y: x * s + n.y * c + dy };
		}),
	};
}
