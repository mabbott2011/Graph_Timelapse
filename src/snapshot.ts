import { App, normalizePath } from "obsidian";
import { GraphNodeInternal, GraphRendererInternal, PixiColor, num } from "./internals";
import type { VaultStats } from "./stats";

/**
 * A snapshot is what the graph looked like at one moment: every node's
 * position, size and colour, and every link. It's the source of truth —
 * images and the embedded timelapse are rendered from it.
 *
 * File layout is one node / one link per line, so Git diffs stay readable
 * and compress well day to day.
 */

export const SNAPSHOT_VERSION = 1;

/** [id, x, y, radius, paletteIndex, title?] */
export type SnapNode = [string, number, number, number, number, string?];
/** [idA, idB] with idA < idB */
export type SnapLink = [string, string];

export interface Snapshot {
	v: number;
	/** "YYYY-MM-DD" or "YYYY-MM-DD_HHmm" — also the file name. */
	key: string;
	takenAt: string;
	stats: VaultStats;
	/** Colours used by nodes, as #rrggbbaa. */
	palette: string[];
	line: { color: string; width: number };
	nodes: SnapNode[];
	links: SnapLink[];
}

/** Raw graph read from Obsidian's graph view before alignment. */
export interface RawGraph {
	nodes: { path: string; x: number; y: number; r: number; color: string }[];
	links: [string, string][];
	line: { color: string; width: number };
}

/**
 * Stable short id for a note path, so titles aren't stored unless asked for.
 *
 * This is pseudonymous, not anonymous: it's a fast non-cryptographic hash
 * (cyrb53), so anyone who can guess a note's path can compute its id and
 * match it. Renaming or moving a note changes its id, so the timelapse
 * shows it as one note leaving and another arriving.
 */
export function nodeId(path: string): string {
	// cyrb53
	let h1 = 0xdeadbeef ^ 0;
	let h2 = 0x41c6ce57 ^ 0;
	for (let i = 0; i < path.length; i++) {
		const ch = path.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function colorHex(c: PixiColor | null | undefined, fallback: string): string {
	if (!c || typeof c.rgb !== "number") return fallback;
	const a = typeof c.a === "number" ? Math.round(Math.max(0, Math.min(1, c.a)) * 255) : 255;
	return "#" + c.rgb.toString(16).padStart(6, "0") + a.toString(16).padStart(2, "0");
}

function nodeSize(n: GraphNodeInternal, sizeMult: number): number {
	let r = NaN;
	try {
		r = typeof n.getSize === "function" ? num(n.getSize(), NaN) : NaN;
	} catch {
		r = NaN;
	}
	// Obsidian's own formula, if getSize isn't available.
	if (!Number.isFinite(r) || r <= 0) r = sizeMult * Math.max(8, Math.min(3 * Math.sqrt(num(n.weight) + 1), 30));
	return r;
}

function nodeFill(n: GraphNodeInternal, colors: Record<string, PixiColor | undefined>): PixiColor | null | undefined {
	try {
		const c = typeof n.getFillColor === "function" ? n.getFillColor() : null;
		if (c) return c;
	} catch {
		/* fall through to type colours */
	}
	if (n.color) return n.color;
	const t = typeof n.type === "string" ? n.type : "";
	return t === "tag" ? colors.fillTag : t === "unresolved" ? colors.fillUnresolved : t === "attachment" ? colors.fillAttachment : colors.fill;
}

/** Read nodes, links and colours from an open graph view's renderer (Obsidian internals, guarded). */
export function extractGraph(renderer: GraphRendererInternal): RawGraph | null {
	const nodes = renderer.nodes;
	if (!Array.isArray(nodes) || nodes.length === 0) return null;
	const colors = renderer.colors ?? {};
	const sizeMult = num(renderer.fNodeSizeMult, 1);

	const out: RawGraph = {
		nodes: [],
		links: [],
		line: { color: colorHex(colors.line, "#88888899"), width: num(renderer.fLineSizeMult, 1) },
	};

	for (const n of nodes) {
		if (typeof n?.id !== "string") continue;
		out.nodes.push({ path: n.id, x: num(n.x), y: num(n.y), r: nodeSize(n, sizeMult), color: colorHex(nodeFill(n, colors), "#b3b3b3ff") });
	}

	const seen = new Set<string>();
	for (const l of renderer.links ?? []) {
		const a = l?.source?.id;
		const b = l?.target?.id;
		if (typeof a !== "string" || typeof b !== "string" || a === b) continue;
		const [p, q] = a < b ? [a, b] : [b, a];
		const k = p + "\u0000" + q;
		if (seen.has(k)) continue;
		seen.add(k);
		out.links.push([p, q]);
	}
	return out;
}

export interface Pt {
	x: number;
	y: number;
}

/**
 * Best rotation (or mirrored rotation) plus shift that moves the `b` points
 * onto the `a` points, in the least-squares sense: 2D Procrustes.
 * Returns null when there are fewer than three pairs to fit.
 */
export function procrustes(pairs: { a: Pt; b: Pt }[]): ((p: Pt) => Pt) | null {
	if (pairs.length < 3) return null;
	const ca = { x: 0, y: 0 };
	const cb = { x: 0, y: 0 };
	for (const { a, b } of pairs) {
		ca.x += a.x;
		ca.y += a.y;
		cb.x += b.x;
		cb.y += b.y;
	}
	ca.x /= pairs.length;
	ca.y /= pairs.length;
	cb.x /= pairs.length;
	cb.y /= pairs.length;

	const fit = (mirror: number) => {
		let num = 0;
		let den = 0;
		for (const { a, b } of pairs) {
			const bx = (b.x - cb.x) * mirror;
			const by = b.y - cb.y;
			const ax = a.x - ca.x;
			const ay = a.y - ca.y;
			num += bx * ay - by * ax;
			den += bx * ax + by * ay;
		}
		const t = Math.atan2(num, den);
		const cos = Math.cos(t);
		const sin = Math.sin(t);
		let err = 0;
		for (const { a, b } of pairs) {
			const bx = (b.x - cb.x) * mirror;
			const by = b.y - cb.y;
			const x = bx * cos - by * sin + ca.x;
			const y = bx * sin + by * cos + ca.y;
			err += (x - a.x) ** 2 + (y - a.y) ** 2;
		}
		return { cos, sin, mirror, err };
	};
	const plain = fit(1);
	const mirrored = fit(-1);
	const best = mirrored.err < plain.err ? mirrored : plain;
	return (p) => {
		const bx = (p.x - cb.x) * best.mirror;
		const by = p.y - cb.y;
		return { x: bx * best.cos - by * best.sin + ca.x, y: bx * best.sin + by * best.cos + ca.y };
	};
}

/**
 * Obsidian lays the graph out from scratch each time it opens, so the same
 * note lands somewhere different every day. Rotate/mirror/shift the new
 * layout to best match the previous snapshot (2D Procrustes on the notes
 * both share), so a timelapse shows growth instead of spinning.
 */
export function align(raw: RawGraph, prev: Snapshot | null): Pt[] {
	const pts = raw.nodes.map((n) => ({ x: n.x, y: n.y }));
	const prevPos = new Map<string, Pt>();
	for (const n of prev?.nodes ?? []) prevPos.set(n[0], { x: n[1], y: n[2] });

	const pairs: { a: Pt; b: Pt }[] = [];
	raw.nodes.forEach((n, i) => {
		const a = prevPos.get(nodeId(n.path));
		if (a) pairs.push({ a, b: pts[i] });
	});

	const fit = procrustes(pairs);
	if (!fit) {
		// Nothing to match against: just centre on the origin.
		const cx = pts.reduce((s, p) => s + p.x, 0) / Math.max(pts.length, 1);
		const cy = pts.reduce((s, p) => s + p.y, 0) / Math.max(pts.length, 1);
		return pts.map((p) => ({ x: p.x - cx, y: p.y - cy }));
	}
	return pts.map(fit);
}

/**
 * Fingerprint of a snapshot's structure: which notes exist, their colours,
 * and the links, but not where they sit. Two snapshots with the same
 * signature show the same graph, only laid out differently.
 */
export function signature(s: Snapshot): string {
	const parts: string[] = [];
	for (const n of s.nodes) parts.push(n[0] + ":" + (s.palette[n[4]] ?? ""));
	parts.push("|");
	for (const [a, b] of s.links) parts.push(a + "-" + b);
	return nodeId(parts.join(",")) + "/" + s.nodes.length + "/" + s.links.length;
}

export function buildSnapshot(key: string, raw: RawGraph, prev: Snapshot | null, stats: VaultStats, includeTitles: boolean): Snapshot {
	const pos = align(raw, prev);
	const palette: string[] = [];
	const pIndex = new Map<string, number>();
	const r1 = (v: number) => Math.round(v * 10) / 10;

	const nodes: SnapNode[] = raw.nodes.map((n, i) => {
		let ci = pIndex.get(n.color);
		if (ci === undefined) {
			ci = palette.length;
			palette.push(n.color);
			pIndex.set(n.color, ci);
		}
		const row: SnapNode = [nodeId(n.path), r1(pos[i].x), r1(pos[i].y), r1(n.r), ci];
		if (includeTitles) row.push(n.path);
		return row;
	});
	nodes.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

	// One entry per pair of notes, whichever way round the link was written.
	const byPair = new Map<string, SnapLink>();
	for (const [a, b] of raw.links) {
		const p = nodeId(a);
		const q = nodeId(b);
		if (p === q) continue;
		const link: SnapLink = p < q ? [p, q] : [q, p];
		byPair.set(link[0] + "|" + link[1], link);
	}
	const links = [...byPair.values()].sort((x, y) => (x[0] + x[1] < y[0] + y[1] ? -1 : 1));

	return { v: SNAPSHOT_VERSION, key, takenAt: new Date().toISOString(), stats, palette, line: raw.line, nodes, links };
}

/** Basic shape check, so a corrupted or foreign file is skipped instead of breaking playback. */
export function isSnapshot(v: unknown): v is Snapshot {
	const s = v as Partial<Snapshot> | null;
	return (
		!!s &&
		typeof s === "object" &&
		typeof s.key === "string" &&
		typeof s.v === "number" &&
		s.v <= SNAPSHOT_VERSION &&
		Array.isArray(s.nodes) &&
		Array.isArray(s.links) &&
		Array.isArray(s.palette) &&
		s.nodes.every((n) => Array.isArray(n) && typeof n[0] === "string" && typeof n[1] === "number" && typeof n[2] === "number" && typeof n[3] === "number")
	);
}

/** One node / one link per line: readable diffs, good compression. */
export function serialize(s: Snapshot): string {
	const head = { v: s.v, key: s.key, takenAt: s.takenAt, stats: s.stats, palette: s.palette, line: s.line };
	const lines: string[] = [];
	lines.push("{");
	for (const [k, v] of Object.entries(head)) lines.push(`${JSON.stringify(k)}: ${JSON.stringify(v)},`);
	lines.push(`"nodes": [`);
	s.nodes.forEach((n, i) => lines.push(JSON.stringify(n) + (i < s.nodes.length - 1 ? "," : "")));
	lines.push("],");
	lines.push(`"links": [`);
	s.links.forEach((l, i) => lines.push(JSON.stringify(l) + (i < s.links.length - 1 ? "," : "")));
	lines.push("]");
	lines.push("}");
	return lines.join("\n") + "\n";
}

/** Most snapshots kept in memory at once (least recently used are dropped first). */
export const CACHE_LIMIT = 150;

/** Reads and writes snapshots in the data folder, with a bounded in-memory cache. */
export class SnapshotStore {
	private cache = new Map<string, Snapshot>();

	private remember(key: string, snap: Snapshot) {
		this.cache.delete(key);
		this.cache.set(key, snap);
		// Map keeps insertion order, so the first keys are the least recently used.
		for (const oldest of this.cache.keys()) {
			if (this.cache.size <= CACHE_LIMIT) break;
			this.cache.delete(oldest);
		}
	}
	private keysCache: string[] | null = null;

	constructor(private app: App, private folder: () => string) {}

	private dir(): string {
		return normalizePath(this.folder() || "_attachments/graph-data");
	}

	invalidate() {
		this.keysCache = null;
	}

	async keys(): Promise<string[]> {
		if (this.keysCache) return this.keysCache;
		const dir = this.dir();
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(dir))) return (this.keysCache = []);
		const list = await adapter.list(dir);
		this.keysCache = list.files
			.map((f) => f.split("/").pop() ?? "")
			.filter((f) => /^\d{4}-\d{2}-\d{2}(_\d{4})?\.json$/.test(f))
			.map((f) => f.replace(/\.json$/, ""))
			.sort();
		return this.keysCache;
	}

	/** `remember: false` reads without filling the cache (e.g. a one-off video export). */
	async load(key: string, remember = true): Promise<Snapshot | null> {
		const hit = this.cache.get(key);
		if (hit) {
			if (remember) this.remember(key, hit); // mark as recently used
			return hit;
		}
		try {
			const text = await this.app.vault.adapter.read(`${this.dir()}/${key}.json`);
			const snap: unknown = JSON.parse(text);
			if (!isSnapshot(snap)) return null;
			if (remember) this.remember(key, snap);
			return snap;
		} catch {
			return null;
		}
	}

	async latest(): Promise<Snapshot | null> {
		const k = await this.keys();
		return k.length ? this.load(k[k.length - 1]) : null;
	}

	async save(snap: Snapshot): Promise<string> {
		const dir = this.dir();
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
		const path = `${dir}/${snap.key}.json`;
		await adapter.write(path, serialize(snap));
		this.remember(snap.key, snap);
		this.invalidate();
		return path;
	}
}
