import type { Snapshot } from "./snapshot";
import { formatStats } from "./stats";

/**
 * Draws snapshots on a plain 2D canvas: real anti-aliased circles and
 * lines at any size, no dependence on Obsidian's renderer.
 */

export interface FrameNode {
	x: number;
	y: number;
	r: number;
	color: string;
	alpha: number;
}

export interface Frame {
	nodes: Map<string, FrameNode>;
	links: { a: string; b: string; alpha: number }[];
	line: { color: string; width: number };
	bounds: Bounds;
	label: string;
}

export interface Bounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export interface DrawOptions {
	width: number;
	height: number;
	padding: number;
	background: string;
	textColor: string;
	font: string;
	stamp: boolean;
}

export function snapshotBounds(s: Snapshot): Bounds {
	const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
	for (const [, x, y, r] of s.nodes) {
		b.minX = Math.min(b.minX, x - r);
		b.minY = Math.min(b.minY, y - r);
		b.maxX = Math.max(b.maxX, x + r);
		b.maxY = Math.max(b.maxY, y + r);
	}
	if (!isFinite(b.minX)) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
	return b;
}

export function label(s: Snapshot): string {
	const when = s.key.replace("_", " ").replace(/ (\d\d)(\d\d)$/, " $1:$2");
	return `${when} · ${formatStats(s.stats)}`;
}

export function frameOf(s: Snapshot): Frame {
	const nodes = new Map<string, FrameNode>();
	for (const [id, x, y, r, ci] of s.nodes) nodes.set(id, { x, y, r, color: s.palette[ci] ?? "#b3b3b3ff", alpha: 1 });
	return {
		nodes,
		links: s.links.map(([a, b]) => ({ a, b, alpha: 1 })),
		line: s.line,
		bounds: snapshotBounds(s),
		label: label(s),
	};
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** Blend two snapshots: shared notes glide, new ones fade in, removed ones fade out. */
export function between(A: Frame, B: Frame, tRaw: number): Frame {
	const t = ease(Math.max(0, Math.min(1, tRaw)));
	const nodes = new Map<string, FrameNode>();
	for (const [id, a] of A.nodes) {
		const b = B.nodes.get(id);
		if (b) nodes.set(id, { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), r: lerp(a.r, b.r, t), color: t < 0.5 ? a.color : b.color, alpha: 1 });
		else nodes.set(id, { ...a, alpha: 1 - t });
	}
	for (const [id, b] of B.nodes) if (!A.nodes.has(id)) nodes.set(id, { ...b, alpha: t });

	const key = (a: string, b: string) => a + "|" + b;
	const inA = new Set(A.links.map((l) => key(l.a, l.b)));
	const inB = new Set(B.links.map((l) => key(l.a, l.b)));
	const links: Frame["links"] = [];
	for (const l of A.links) links.push({ a: l.a, b: l.b, alpha: inB.has(key(l.a, l.b)) ? 1 : 1 - t });
	for (const l of B.links) if (!inA.has(key(l.a, l.b))) links.push({ a: l.a, b: l.b, alpha: t });

	return {
		nodes,
		links,
		line: t < 0.5 ? A.line : B.line,
		bounds: {
			minX: lerp(A.bounds.minX, B.bounds.minX, t),
			minY: lerp(A.bounds.minY, B.bounds.minY, t),
			maxX: lerp(A.bounds.maxX, B.bounds.maxX, t),
			maxY: lerp(A.bounds.maxY, B.bounds.maxY, t),
		},
		label: t < 0.5 ? A.label : B.label,
	};
}

/** #rrggbbaa → rgba() with an extra alpha multiplier. */
function rgba(hex: string, mult: number): string {
	const h = hex.replace("#", "");
	const r = parseInt(h.slice(0, 2), 16);
	const g = parseInt(h.slice(2, 4), 16);
	const b = parseInt(h.slice(4, 6), 16);
	const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
	return `rgba(${r},${g},${b},${(a * mult).toFixed(3)})`;
}

export function stampHeight(o: DrawOptions): number {
	return o.stamp ? Math.round(o.height / 18) : 0;
}

/** Draw a frame centred and fitted into width × height (in canvas pixels). */
export function drawFrame(ctx: CanvasRenderingContext2D, f: Frame, o: DrawOptions) {
	ctx.save();
	ctx.fillStyle = o.background;
	ctx.fillRect(0, 0, o.width, o.height);

	const boxW = Math.max(o.width - o.padding * 2, 10);
	const boxH = Math.max(o.height - o.padding * 2 - stampHeight(o), 10);
	const bw = Math.max(f.bounds.maxX - f.bounds.minX, 1);
	const bh = Math.max(f.bounds.maxY - f.bounds.minY, 1);
	const k = Math.min(boxW / bw, boxH / bh);
	const ox = o.padding + (boxW - bw * k) / 2 - f.bounds.minX * k;
	const oy = o.padding + (boxH - bh * k) / 2 - f.bounds.minY * k;
	const X = (x: number) => ox + x * k;
	const Y = (y: number) => oy + y * k;

	// Links: thin, under the nodes. Width follows Obsidian's line-thickness setting.
	ctx.lineWidth = Math.max(0.5, Math.min(2.5, f.line.width * Math.max(o.width, o.height) / 1400));
	ctx.lineCap = "round";
	for (const l of f.links) {
		const a = f.nodes.get(l.a);
		const b = f.nodes.get(l.b);
		if (!a || !b) continue;
		const alpha = l.alpha * Math.min(a.alpha, b.alpha);
		if (alpha <= 0.01) continue;
		ctx.strokeStyle = rgba(f.line.color, alpha);
		ctx.beginPath();
		ctx.moveTo(X(a.x), Y(a.y));
		ctx.lineTo(X(b.x), Y(b.y));
		ctx.stroke();
	}

	// Nodes: smallest first so hubs sit on top.
	const ordered = [...f.nodes.values()].sort((p, q) => p.r - q.r);
	for (const n of ordered) {
		if (n.alpha <= 0.01) continue;
		ctx.fillStyle = rgba(n.color, n.alpha);
		ctx.beginPath();
		ctx.arc(X(n.x), Y(n.y), Math.max(0.8, n.r * k), 0, Math.PI * 2);
		ctx.fill();
	}

	if (o.stamp && f.label) {
		const size = Math.max(11, Math.round(o.height / 45));
		ctx.font = `${size}px ${o.font}`;
		ctx.fillStyle = o.textColor;
		ctx.textBaseline = "bottom";
		ctx.fillText(f.label, o.padding, o.height - o.padding / 2);
	}
	ctx.restore();
}

export function themeColors(el: HTMLElement = document.body): { background: string; text: string; font: string } {
	const css = getComputedStyle(el);
	const body = getComputedStyle(document.body);
	const pick = (...vals: string[]) => vals.map((v) => v.trim()).find((v) => v && v !== "rgba(0, 0, 0, 0)") ?? "";
	return {
		background: pick(css.getPropertyValue("--background-primary"), body.getPropertyValue("--background-primary"), "#1e1e1e"),
		text: pick(css.getPropertyValue("--text-muted"), body.getPropertyValue("--text-muted"), "#999999"),
		font: pick(body.getPropertyValue("--font-interface"), "sans-serif"),
	};
}

/** Render one snapshot to a PNG. */
export async function snapshotToPng(s: Snapshot, o: DrawOptions): Promise<ArrayBuffer> {
	const c = document.createElement("canvas");
	c.width = o.width;
	c.height = o.height;
	const ctx = c.getContext("2d");
	if (!ctx) throw new Error("No 2D canvas");
	drawFrame(ctx, frameOf(s), o);
	return new Promise((resolve, reject) =>
		c.toBlob((blob) => (blob ? blob.arrayBuffer().then(resolve, reject) : reject(new Error("PNG encode failed"))), "image/png"),
	);
}
