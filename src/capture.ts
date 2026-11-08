import { App, Platform, WorkspaceLeaf } from "obsidian";
import { RawGraph, extractGraph } from "./snapshot";

/**
 * How the graph gets captured.
 *
 * Obsidian's graph view is not a public API. It draws with PIXI.js (WebGL)
 * inside `leaf.view.renderer`. We use those internals defensively and fall
 * back step by step, so an Obsidian update degrades the image instead of
 * breaking the plugin:
 *
 *   1. PIXI extract  - renders the whole graph (not just what's on screen)
 *                      to a texture at the resolution we need. Best result.
 *   2. capturePage   - Electron screenshot of the graph pane. Desktop only.
 *   3. canvas copy   - copy the graph's <canvas>. May come out blank on WebGL.
 */

export interface CaptureOptions {
	width: number;
	height: number;
	padding: number;
	/** Wait at least this long for the layout to settle. */
	settleMs: number;
	/** Give up waiting for the layout to settle after this long. */
	maxWaitMs: number;
	/** CSS color, or "" to use the theme background. */
	background: string;
	/** Text stamped in the bottom-left corner, or null for none. */
	stamp: string | null;
	/**
	 * Also capture a PNG straight from Obsidian's renderer. Only needed when
	 * the graph data can't be read (then images are drawn from data instead).
	 */
	pixiPng: "never" | "if-no-data";
}

export interface CaptureResult {
	png: ArrayBuffer | null;
	method: "pixi" | "screenshot" | "canvas" | null;
	/** Nodes, links and colours read from the graph view, or null if that failed. */
	graph: RawGraph | null;
	/** What happened during the capture, written to last-capture.json for troubleshooting. */
	debug: Record<string, unknown>[];
}

let debugLog: Record<string, unknown>[] = [];
function dbg(step: string, data: Record<string, unknown> = {}) {
	debugLog.push({ step, ...data });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

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

		const view: Any = leaf.view;
		const renderer: Any = await waitFor(() => view?.renderer?.px ?? null, 10_000)
			.then(() => view.renderer)
			.catch(() => view?.renderer ?? null);

		await waitForSettle(renderer, opts.settleMs, opts.maxWaitMs);
		let graph: RawGraph | null = null;
		try {
			graph = extractGraph(renderer);
		} catch (e) {
			dbg("extract-error", { error: String(e) });
		}
		dbg("extract", { nodes: graph?.nodes.length ?? 0, links: graph?.links.length ?? 0 });
		if (!graph) dbg("graph-data", describeGraphData(renderer));
		if (graph || opts.pixiPng === "never") return { png: null, method: null, graph, debug: debugLog };

		for (let i = 0; i < 3; i++) await nextFrame();

		const theme = themeColors(view.containerEl as HTMLElement);
		const bg = opts.background.trim() || theme.background;

		let source: HTMLCanvasElement | null = null;
		let method: CaptureResult["method"] = "pixi";

		source = pixiExtract(renderer, opts);
		if (!source) {
			method = "screenshot";
			source = cropToContent(await electronScreenshot(view.containerEl as HTMLElement));
		}
		if (!source) {
			method = "canvas";
			source = cropToContent(canvasCopy(view.containerEl as HTMLElement));
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

async function waitFor<T>(fn: () => T | null | undefined, timeoutMs: number): Promise<T> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const v = fn();
		if (v) return v;
		await sleep(100);
	}
	throw new Error("timeout");
}

/** Wait until nodes stop moving (force layout settled), within limits. */
async function waitForSettle(renderer: Any, minMs: number, maxMs: number): Promise<void> {
	const start = Date.now();
	await sleep(minMs);

	const positions = (): number[] | null => {
		const nodes: Any[] | undefined = renderer?.nodes;
		if (!Array.isArray(nodes) || nodes.length === 0) return null;
		const out: number[] = [];
		for (const n of nodes) out.push(Number(n?.x) || 0, Number(n?.y) || 0);
		return out;
	};

	let last = positions();
	if (!last) return; // can't observe the layout; the minimum wait will do
	let calm = 0;
	while (Date.now() - start < maxMs) {
		await sleep(500);
		const now = positions();
		if (!now || !last || now.length !== last.length) {
			last = now;
			calm = 0;
			continue;
		}
		let moved = 0;
		for (let i = 0; i < now.length; i++) moved += Math.abs(now[i] - last[i]);
		const avg = moved / (now.length / 2);
		calm = avg < 0.3 ? calm + 1 : 0;
		if (calm >= 2) return;
		last = now;
	}
}

/** Supersample: render the graph at this multiple of its final size, then scale down. */
const SUPERSAMPLE = 2;
/** Keep GPU textures within limits every device supports. */
const MAX_TEXTURE = 4096;

/**
 * The graph view zooms and pans by transforming the PIXI stage. Rendering the
 * stage to a texture applies that transform, but the stage's bounds don't
 * include it, so earlier versions drew the graph tiny and off in a corner.
 * Fix: put the stage at a neutral transform just for the capture (it's
 * restored before the next frame, so nothing flickers), then check the
 * result actually filled the image before trusting it.
 */
function pixiExtract(renderer: Any, opts: CaptureOptions): HTMLCanvasElement | null {
	const px = renderer?.px;
	const r = px?.renderer;
	const stage = px?.stage;
	if (!r || !stage) return null;

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
		if (!b || !(b.width > 0) || !(b.height > 0)) return null;

		// Overview: longest side ~1024 px.
		const r1 = Math.min(1024 / b.width, 1024 / b.height, 8);
		const overview = renderRegion(r, stage, null, r1);
		if (!overview) return null;
		const box = contentBox(overview);
		dbg("overview", {
			savedTransform: saved,
			bounds: { x: b.x, y: b.y, w: b.width, h: b.height },
			canvas: [overview.width, overview.height],
			content: box,
		});
		if (!box) return null;

		// Size of the graph in stage units, then the resolution that fills the output.
		const unitsPerPx = b.width / overview.width;
		const graphW = box.w * unitsPerPx;
		const graphH = box.h * unitsPerPx;
		const targetW = Math.max(opts.width - opts.padding * 2, 50) * SUPERSAMPLE;
		const targetH = Math.max(opts.height - opts.padding * 2 - stampSpace(opts), 50) * SUPERSAMPLE;
		let r2 = Math.min(targetW / graphW, targetH / graphH);
		r2 = Math.min(r2, MAX_TEXTURE / b.width, MAX_TEXTURE / b.height);

		// Best: render only the graph's own region. The stage's bounds can be ~10× the
		// graph (mostly empty), which otherwise caps resolution at the texture limit.
		const margin = 0.03 * Math.max(graphW, graphH);
		const lx = b.x + box.x * unitsPerPx - margin;
		const ly = b.y + box.y * unitsPerPx - margin;
		const lw = graphW + margin * 2;
		const lh = graphH + margin * 2;
		const rr = Math.min(targetW / graphW, targetH / graphH, MAX_TEXTURE / lw, MAX_TEXTURE / lh);
		dbg("plan", { graphW, graphH, r1, r2, region: { lx, ly, lw, lh }, rr });

		const check = (c: HTMLCanvasElement | null, name: string, expected: number) => {
			const box2 = c ? contentBox(c) : null;
			const ok = !!box2 && Math.abs(box2.w - expected) / expected < 0.25;
			dbg(name, { canvas: c ? [c.width, c.height] : null, content: box2, expected, ok });
			return ok;
		};

		if (rr > r1 * 1.2) {
			const Rect = b.constructor as Any;
			const region = new Rect(lx, ly, lw, lh);
			const rc = renderRegion(r, stage, region, rr);
			if (check(rc, "A0-region", graphW * rr)) return cropToContent(rc);
		}

		if (r2 > r1 * 1.2) {
			const expected = graphW * r2;
			const good = (c: HTMLCanvasElement | null, name: string) => check(c, name, expected);

			// A: PIXI's own resolution option.
			const a = renderRegion(r, stage, null, r2);
			if (good(a, "A-resolution")) return cropToContent(a);

			// B: scale the stage itself, render at resolution 1, region = its scaled bounds.
			try {
				stage.scale?.set?.(r2, r2);
				const wb = stage.getBounds();
				const Rect = wb.constructor as Any;
				const region = new Rect(wb.x, wb.y, wb.width, wb.height);
				dbg("B-bounds", { x: wb.x, y: wb.y, w: wb.width, h: wb.height });
				const bc = renderRegion(r, stage, region, 1);
				if (good(bc, "B-scale+region")) return cropToContent(bc);
				const bn = renderRegion(r, stage, null, 1);
				if (good(bn, "B-scale")) return cropToContent(bn);
			} finally {
				stage.scale?.set?.(1, 1);
			}
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
			/* ignore */
		}
	}
}

/** Render `target` (optionally only `region`, in its local coords) to a 2D canvas. Handles PIXI v6/v7 and v8. */
function renderRegion(r: Any, target: Any, region: Any, resolution: number): HTMLCanvasElement | null {
	const extract = r.extract ?? r.plugins?.extract;
	if (!extract?.canvas) return null;

	let texture: Any = null;
	const attempts: Array<() => Any> = [
		() => r.generateTexture(target, region ? { region, resolution } : { resolution }), // v7
		() => r.generateTexture({ target, frame: region ?? undefined, resolution }), // v8
	];
	for (const tryIt of attempts) {
		try {
			texture = tryIt();
			if (texture) break;
		} catch {
			texture = null;
		}
	}
	if (!texture) return null;

	let c: Any = null;
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
			/* ignore */
		}
	}
	if (!c || typeof c.getContext !== "function" || !(c.width > 0) || !(c.height > 0)) return null;

	// Normalise to a plain 2D canvas we can read pixels from.
	const out = document.createElement("canvas");
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
	let minX = W, minY = H, maxX = -1, maxY = -1;
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
	const out = document.createElement("canvas");
	out.width = w;
	out.height = h;
	out.getContext("2d")?.drawImage(c, x, y, w, h, 0, 0, w, h);
	return out;
}

function stampSpace(opts: CaptureOptions): number {
	return opts.stamp ? Math.round(opts.height / 18) : 0;
}

async function electronScreenshot(el: HTMLElement): Promise<HTMLCanvasElement | null> {
	if (!Platform.isDesktopApp) return null;
	try {
		const electron: Any = (window as Any).require?.("electron");
		const wc = electron?.remote?.getCurrentWebContents?.();
		if (!wc?.capturePage) return null;
		const target = (el.querySelector(".view-content") as HTMLElement | null) ?? el;
		const r = target.getBoundingClientRect();
		const img = await wc.capturePage({
			x: Math.round(r.left),
			y: Math.round(r.top),
			width: Math.round(r.width),
			height: Math.round(r.height),
		});
		return await imageToCanvas(img.toDataURL());
	} catch (e) {
		console.warn("[graph-timelapse] screenshot failed", e);
		return null;
	}
}

function canvasCopy(el: HTMLElement): HTMLCanvasElement | null {
	const src = el.querySelector("canvas");
	if (!src || src.width === 0 || src.height === 0) return null;
	const c = document.createElement("canvas");
	c.width = src.width;
	c.height = src.height;
	c.getContext("2d")?.drawImage(src, 0, 0);
	return c;
}

function imageToCanvas(dataUrl: string): Promise<HTMLCanvasElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => {
			const c = document.createElement("canvas");
			c.width = img.naturalWidth;
			c.height = img.naturalHeight;
			c.getContext("2d")?.drawImage(img, 0, 0);
			resolve(c);
		};
		img.onerror = () => reject(new Error("image load failed"));
		img.src = dataUrl;
	});
}

function themeColors(el: HTMLElement): { background: string; text: string; font: string } {
	const css = getComputedStyle(el);
	const body = getComputedStyle(document.body);
	const pick = (...vals: string[]) => vals.map((v) => v.trim()).find((v) => v && v !== "rgba(0, 0, 0, 0)") ?? "";
	return {
		background: pick(css.getPropertyValue("--background-primary"), body.getPropertyValue("--background-primary"), "#1e1e1e"),
		text: pick(css.getPropertyValue("--text-muted"), body.getPropertyValue("--text-muted"), "#999999"),
		font: pick(body.getPropertyValue("--font-interface"), "sans-serif"),
	};
}

/** Place the capture centred on a fixed-size canvas so every day lines up. */
function compose(src: HTMLCanvasElement, opts: CaptureOptions, bg: string, textColor: string, font: string): HTMLCanvasElement {
	const out = document.createElement("canvas");
	out.width = opts.width;
	out.height = opts.height;
	const ctx = out.getContext("2d");
	if (!ctx) return src;

	ctx.fillStyle = bg;
	ctx.fillRect(0, 0, out.width, out.height);

	const stamp = stampSpace(opts);
	const boxW = opts.width - opts.padding * 2;
	const boxH = opts.height - opts.padding * 2 - stamp;
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
			if (!blob) return reject(new Error("PNG encode failed"));
			blob.arrayBuffer().then(resolve, reject);
		}, "image/png");
	});
}

/** Shape of the renderer's node/link data, for the "redraw it ourselves" option. Keys and primitive values only. */
function describeGraphData(renderer: Any): Record<string, unknown> {
	const shape = (o: Any) => {
		if (!o || typeof o !== "object") return o;
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(o).slice(0, 40)) {
			const v = o[k];
			out[k] = v === null || ["number", "string", "boolean"].includes(typeof v) ? v : Array.isArray(v) ? `array(${v.length})` : typeof v === "object" ? `{${Object.keys(v).slice(0, 12).join(",")}}` : typeof v;
		}
		return out;
	};
	try {
		return {
			rendererKeys: renderer ? Object.keys(renderer).slice(0, 60) : null,
			nodeCount: renderer?.nodes?.length,
			node0: shape(renderer?.nodes?.[0]),
			linkCount: renderer?.links?.length,
			link0: shape(renderer?.links?.[0]),
			colors: shape(renderer?.colors),
		};
	} catch (e) {
		return { error: String(e) };
	}
}
