import { App, WorkspaceLeaf } from "obsidian";
import { GraphRendererInternal, GraphViewInternal, PixiContainer, PixiRect, PixiRenderer, PixiTexture, isCanvas, num } from "./internals";
import { themeColors } from "./render";
import { RawGraph, extractGraph } from "./snapshot";

/**
 * Opens the graph view in a tab, waits for the layout to settle, reads the
 * graph data, and closes the tab again.
 *
 * Normally that's all: images are drawn from the data. Only if the data
 * can't be read (an Obsidian update changed the internals) does it fall
 * back to copying Obsidian's own rendering as an image:
 *
 *   1. PIXI region render - re-render just the graph at the size we need.
 *   2. Canvas copy        - copy the graph's <canvas>. May come out blank.
 */

export interface CaptureOptions {
	width: number;
	height: number;
	padding: number;
	/** Wait at least this long for the layout to settle. */
	settleMs: number;
	/** Give up waiting for the layout to settle after this long. */
	maxWaitMs: number;
	/** CSS colour, or "" to use the theme background. */
	background: string;
	/** Text stamped in the bottom-left corner, or null for none. */
	stamp: string | null;
	/** Capture an image from Obsidian's renderer if the graph data can't be read. */
	pixiPng: "never" | "if-no-data";
	/**
	 * Refuse to record a layout that never moved (throws LayoutNotRunError).
	 * With Obsidian minimised or in the background the graph may not animate,
	 * and an unfinished layout is recorded as if it were settled.
	 */
	requireLayout?: boolean;
}

/** The graph layout never ran, so there's nothing trustworthy to record; try again later. */
export class LayoutNotRunError extends Error {
	constructor() {
		super("The graph layout didn't run (is Obsidian in the background?). Will try again later.");
	}
}

export interface CaptureResult {
	png: ArrayBuffer | null;
	method: "pixi" | "canvas" | null;
	/** Nodes, links and colours read from the graph view, or null if that failed. */
	graph: RawGraph | null;
	/** What happened during the capture, written to last-capture.json for troubleshooting. */
	debug: Record<string, unknown>[];
}

let debugLog: Record<string, unknown>[] = [];
function dbg(step: string, data: Record<string, unknown> = {}) {
	debugLog.push({ step, ...data });
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const nextFrame = () => new Promise<void>((r) => window.requestAnimationFrame(() => r()));

export async function captureGraph(app: App, opts: CaptureOptions): Promise<CaptureResult> {
	const ws = app.workspace;
	const previous = ws.getMostRecentLeaf();
	const leaf: WorkspaceLeaf = ws.getLeaf("tab");
	debugLog = [];

	try {
		await leaf.setViewState({ type: "graph", active: true });
		await ws.revealLeaf(leaf);

		const view = leaf.view as unknown as GraphViewInternal;
		const renderer = await waitFor(() => (view.renderer?.px ? view.renderer : null), 10_000);

		const settle = await waitForSettle(renderer, opts.settleMs, opts.maxWaitMs);
		dbg("settle", { ...settle });
		if (opts.requireLayout && settle.observable && !settle.moved) throw new LayoutNotRunError();
		let graph: RawGraph | null = null;
		try {
			graph = renderer ? extractGraph(renderer) : null;
		} catch (e) {
			dbg("extract-error", { error: String(e) });
		}
		dbg("extract", { nodes: graph?.nodes.length ?? 0, links: graph?.links.length ?? 0 });
		if (graph || opts.pixiPng === "never") return { png: null, method: null, graph, debug: debugLog };

		for (let i = 0; i < 3; i++) await nextFrame();

		const container = view.containerEl ?? activeDocument.body;
		const theme = themeColors(container);
		const bg = opts.background.trim() || theme.background;

		let method: CaptureResult["method"] = "pixi";
		let source = renderer ? pixiExtract(renderer, opts) : null;
		if (!source) {
			method = "canvas";
			source = cropToContent(canvasCopy(container));
		}
		if (!source) throw new Error("Could not capture the graph view.");
		dbg("source", { method, w: source.width, h: source.height });

		const out = compose(source, opts, bg, theme.text, theme.font);
		return { png: await toPng(out), method, graph, debug: debugLog };
	} finally {
		leaf.detach();
		if (previous) ws.setActiveLeaf(previous, { focus: false });
	}
}

async function waitFor<T>(fn: () => T | null | undefined, timeoutMs: number): Promise<T | null> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const v = fn();
		if (v) return v;
		await sleep(100);
	}
	return null;
}

interface SettleResult {
	/** Positions could be read at all. */
	observable: boolean;
	/** The layout was seen moving. A layout that never moves wasn't running. */
	moved: boolean;
	/** It came to rest (rather than hitting the time limit). */
	settled: boolean;
	ms: number;
	/** Average movement per node in the last half second. */
	lastMove: number;
	/** The Obsidian window was hidden or unfocused. */
	background: boolean;
}

const CALM = 0.3; // average movement per node per half second that counts as "at rest"
const CALM_CHECKS = 3; // ...for this many checks in a row (1.5 s)

/**
 * Wait until the force layout has run and come to rest, within limits.
 * Calm only counts after the layout has been seen moving: a layout that
 * hasn't started yet (or isn't being animated) also looks perfectly still.
 */
async function waitForSettle(renderer: GraphRendererInternal | null, minMs: number, maxMs: number): Promise<SettleResult> {
	const start = Date.now();
	const background = activeDocument.hidden || !activeDocument.hasFocus();
	const positions = (): number[] | null => {
		const nodes = renderer?.nodes;
		if (!Array.isArray(nodes) || nodes.length === 0) return null;
		const out: number[] = [];
		for (const n of nodes) out.push(num(n?.x), num(n?.y));
		return out;
	};
	const avgMove = (a: number[] | null, b: number[] | null): number | null => {
		if (!a || !b || a.length !== b.length) return null;
		let moved = 0;
		for (let i = 0; i < a.length; i++) moved += Math.abs(a[i] - b[i]);
		return moved / (a.length / 2);
	};

	const initial = positions();
	await sleep(minMs);
	let last = positions();
	const result: SettleResult = { observable: !!last, moved: false, settled: false, ms: 0, lastMove: 0, background };
	if (!last) {
		result.ms = Date.now() - start;
		return result; // can't observe the layout; the minimum wait will do
	}
	result.moved = (avgMove(initial, last) ?? 0) >= CALM;

	let calm = 0;
	while (Date.now() - start < maxMs) {
		await sleep(500);
		const now = positions();
		const move = avgMove(last, now);
		last = now;
		if (move === null) {
			calm = 0;
			continue;
		}
		result.lastMove = Math.round(move * 100) / 100;
		if (move >= CALM) {
			result.moved = true;
			calm = 0;
		} else if (result.moved && ++calm >= CALM_CHECKS) {
			result.settled = true;
			break;
		} else if (!result.moved && Date.now() - start >= minMs + 3000) {
			break; // still after the minimum wait plus 3 s: it isn't going to start
		}
	}
	result.ms = Date.now() - start;
	return result;
}

/** Supersample: render the graph at this multiple of its final size, then scale down. */
const SUPERSAMPLE = 2;
/** Keep GPU textures within limits every device supports. */
const MAX_TEXTURE = 4096;

type RectCtor = new (x: number, y: number, w: number, h: number) => PixiRect;

/**
 * Fallback image capture from Obsidian's PIXI renderer.
 *
 * The graph view zooms and pans by transforming the stage, and the stage's
 * bounds are ~10× bigger than the graph. So: neutral transform for the
 * capture (restored before the next frame), a small overview to find the
 * graph, then a re-render of just that region at the size we need.
 */
function pixiExtract(renderer: GraphRendererInternal, opts: CaptureOptions): HTMLCanvasElement | null {
	const r = renderer.px?.renderer;
	const stage = renderer.px?.stage;
	if (!r || !stage?.getLocalBounds) return null;

	const saved = {
		x: stage.position?.x ?? 0,
		y: stage.position?.y ?? 0,
		sx: stage.scale?.x ?? 1,
		sy: stage.scale?.y ?? 1,
		pvx: stage.pivot?.x ?? 0,
		pvy: stage.pivot?.y ?? 0,
		rot: stage.rotation ?? 0,
	};
	try {
		stage.position?.set?.(0, 0);
		stage.scale?.set?.(1, 1);
		stage.pivot?.set?.(0, 0);
		stage.rotation = 0;

		const b = stage.getLocalBounds();
		if (!(b.width > 0) || !(b.height > 0)) return null;

		const r1 = Math.min(1024 / b.width, 1024 / b.height, 8);
		const overview = renderRegion(r, stage, null, r1);
		if (!overview) return null;
		const box = contentBox(overview);
		dbg("overview", { bounds: { x: b.x, y: b.y, w: b.width, h: b.height }, canvas: [overview.width, overview.height], content: box });
		if (!box) return null;

		const unitsPerPx = b.width / overview.width;
		const graphW = box.w * unitsPerPx;
		const graphH = box.h * unitsPerPx;
		const margin = 0.03 * Math.max(graphW, graphH);
		const lw = graphW + margin * 2;
		const lh = graphH + margin * 2;
		const targetW = Math.max(opts.width - opts.padding * 2, 50) * SUPERSAMPLE;
		const targetH = Math.max(opts.height - opts.padding * 2 - stampSpace(opts), 50) * SUPERSAMPLE;
		const rr = Math.min(targetW / graphW, targetH / graphH, MAX_TEXTURE / lw, MAX_TEXTURE / lh);

		if (rr > r1 * 1.2) {
			const Rect = b.constructor as RectCtor;
			const region = new Rect(b.x + box.x * unitsPerPx - margin, b.y + box.y * unitsPerPx - margin, lw, lh);
			const rc = renderRegion(r, stage, region, rr);
			const rbox = rc ? contentBox(rc) : null;
			const expected = graphW * rr;
			const ok = !!rbox && Math.abs(rbox.w - expected) / expected < 0.25;
			dbg("region", { rr, canvas: rc ? [rc.width, rc.height] : null, content: rbox, expected, ok });
			if (rc && ok) return cropToContent(rc);
		}
		dbg("fallback-overview");
		return cropToContent(overview);
	} catch (e) {
		console.warn("[graph-timelapse] PIXI extract failed", e);
		return null;
	} finally {
		try {
			stage.position?.set?.(saved.x, saved.y);
			stage.scale?.set?.(saved.sx, saved.sy);
			stage.pivot?.set?.(saved.pvx, saved.pvy);
			stage.rotation = saved.rot;
		} catch {
			/* restoring is best effort */
		}
	}
}

/** Render `target` (optionally only `region`, in its local coords) to a 2D canvas. Handles PIXI v6/v7 and v8. */
function renderRegion(r: PixiRenderer, target: PixiContainer, region: PixiRect | null, resolution: number): HTMLCanvasElement | null {
	const extract = r.extract ?? r.plugins?.extract;
	if (!extract?.canvas || !r.generateTexture) return null;
	const gen = (...args: unknown[]): PixiTexture | null => r.generateTexture?.(...args) ?? null;

	const attempts: (() => PixiTexture | null)[] = [
		() => gen(target, region ? { region, resolution } : { resolution }), // v7
		() => gen({ target, frame: region ?? undefined, resolution }), // v8
	];
	let texture: PixiTexture | null = null;
	for (const tryIt of attempts) {
		try {
			texture = tryIt();
			if (texture) break;
		} catch {
			texture = null;
		}
	}
	if (!texture) return null;

	let c: unknown = null;
	try {
		c = extract.canvas(texture);
	} catch {
		try {
			c = extract.canvas({ target: texture });
		} catch {
			c = null;
		}
	} finally {
		try {
			texture.destroy?.(true);
		} catch {
			/* texture cleanup is best effort */
		}
	}
	if (!isCanvas(c)) return null;

	// Normalise to a plain 2D canvas we can read pixels from.
	const out = createEl("canvas");
	out.width = c.width;
	out.height = c.height;
	out.getContext("2d")?.drawImage(c, 0, 0);
	return out;
}

/** Bounding box of pixels that differ from the top-left corner (the background). */
function contentBox(c: HTMLCanvasElement): { x: number; y: number; w: number; h: number } | null {
	const ctx = c.getContext("2d", { willReadFrequently: true });
	if (!ctx) return null;
	const W = c.width;
	const H = c.height;
	const d = ctx.getImageData(0, 0, W, H).data;
	const [br, bg, bb, ba] = [d[0], d[1], d[2], d[3]];
	let minX = W;
	let minY = H;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const i = (y * W + x) * 4;
			const diff = Math.abs(d[i] - br) + Math.abs(d[i + 1] - bg) + Math.abs(d[i + 2] - bb) + Math.abs(d[i + 3] - ba);
			if (diff > 40) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}
	if (maxX < 0) return null;
	return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function cropToContent(c: HTMLCanvasElement | null): HTMLCanvasElement | null {
	if (!c) return null;
	const box = contentBox(c);
	if (!box) return c;
	const m = Math.round(0.02 * Math.max(box.w, box.h));
	const x = Math.max(0, box.x - m);
	const y = Math.max(0, box.y - m);
	const w = Math.min(c.width - x, box.w + m * 2);
	const h = Math.min(c.height - y, box.h + m * 2);
	const out = createEl("canvas");
	out.width = w;
	out.height = h;
	out.getContext("2d")?.drawImage(c, x, y, w, h, 0, 0, w, h);
	return out;
}

function stampSpace(opts: CaptureOptions): number {
	return opts.stamp ? Math.round(opts.height / 18) : 0;
}

function canvasCopy(el: HTMLElement): HTMLCanvasElement | null {
	const src = el.querySelector("canvas");
	if (!src || src.width === 0 || src.height === 0) return null;
	const c = createEl("canvas");
	c.width = src.width;
	c.height = src.height;
	c.getContext("2d")?.drawImage(src, 0, 0);
	return c;
}

/** Place the capture centred on a fixed-size canvas so every day lines up. */
function compose(src: HTMLCanvasElement, opts: CaptureOptions, bg: string, textColor: string, font: string): HTMLCanvasElement {
	const out = createEl("canvas");
	out.width = opts.width;
	out.height = opts.height;
	const ctx = out.getContext("2d");
	if (!ctx) return src;

	ctx.fillStyle = bg;
	ctx.fillRect(0, 0, out.width, out.height);

	const boxW = opts.width - opts.padding * 2;
	const boxH = opts.height - opts.padding * 2 - stampSpace(opts);
	const scale = Math.min(boxW / src.width, boxH / src.height);
	const w = src.width * scale;
	const h = src.height * scale;
	ctx.imageSmoothingQuality = "high";
	ctx.drawImage(src, opts.padding + (boxW - w) / 2, opts.padding + (boxH - h) / 2, w, h);

	if (opts.stamp) {
		const size = Math.max(12, Math.round(opts.height / 45));
		ctx.font = `${size}px ${font}`;
		ctx.fillStyle = textColor;
		ctx.textBaseline = "bottom";
		ctx.fillText(opts.stamp, opts.padding, opts.height - opts.padding / 2);
	}
	return out;
}

function toPng(c: HTMLCanvasElement): Promise<ArrayBuffer> {
	return new Promise((resolve, reject) => {
		c.toBlob((blob) => {
			if (!blob) {
				reject(new Error("PNG encode failed"));
				return;
			}
			blob.arrayBuffer().then(resolve, reject);
		}, "image/png");
	});
}
