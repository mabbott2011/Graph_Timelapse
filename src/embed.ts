import { MarkdownRenderChild } from "obsidian";
import { DrawOptions, Frame, between, drawFrame, frameOf, themeColors } from "./render";
import type { Snapshot, SnapshotStore } from "./snapshot";

/**
 * ```graph-timelapse
 * mode: loop          # loop | once | still
 * date: latest        # still mode: which snapshot (YYYY-MM-DD or latest)
 * from: 2026-11-01    # optional range
 * to: latest
 * speed: 2            # snapshots per second
 * hold: 2             # seconds to pause on the last frame before looping
 * height: 420         # px
 * stamp: true         # date and counts in the corner
 * max-frames: 120     # long histories are sampled evenly to this many
 * ```
 */

export interface EmbedConfig {
	mode: "loop" | "once" | "still";
	date: string;
	from: string;
	to: string;
	speed: number;
	hold: number;
	height: number;
	stamp: boolean;
	maxFrames: number;
}

export function parseConfig(src: string): EmbedConfig {
	const cfg: EmbedConfig = { mode: "loop", date: "latest", from: "", to: "latest", speed: 2, hold: 2, height: 420, stamp: true, maxFrames: 120 };
	for (const raw of src.split(/\r?\n/)) {
		const line = raw.replace(/#.*$/, "").trim();
		const m = line.match(/^([\w-]+)\s*:\s*(.+)$/);
		if (!m) continue;
		const key = m[1].toLowerCase();
		const val = m[2].trim();
		const num = parseFloat(val);
		switch (key) {
			case "mode":
				if (val === "loop" || val === "once" || val === "still") cfg.mode = val;
				break;
			case "date":
				cfg.date = val;
				break;
			case "from":
				cfg.from = val;
				break;
			case "to":
				cfg.to = val;
				break;
			case "speed":
				if (num > 0) cfg.speed = Math.min(num, 30);
				break;
			case "hold":
				if (num >= 0) cfg.hold = num;
				break;
			case "height":
				if (num >= 100) cfg.height = Math.min(num, 2000);
				break;
			case "stamp":
				cfg.stamp = !/^(false|no|off|0)$/i.test(val);
				break;
			case "max-frames":
				if (num >= 2) cfg.maxFrames = Math.floor(num);
				break;
		}
	}
	return cfg;
}

function sample<T>(arr: T[], max: number): T[] {
	if (arr.length <= max) return arr;
	const out: T[] = [];
	for (let i = 0; i < max; i++) out.push(arr[Math.round((i * (arr.length - 1)) / (max - 1))]);
	return out;
}

export class TimelapseEmbed extends MarkdownRenderChild {
	private canvas!: HTMLCanvasElement;
	private frames: Frame[] = [];
	private raf = 0;
	private visible = true;
	private paused = false;
	private start = 0;
	private pausedAt = 0;

	constructor(
		containerEl: HTMLElement,
		private cfg: EmbedConfig,
		private store: SnapshotStore,
	) {
		super(containerEl);
	}

	onload() {
		void this.init();
	}

	private async init() {
		const el = this.containerEl;
		el.addClass("graph-timelapse-embed");
		el.setCssProps({ height: `${this.cfg.height}px` });
		this.canvas = el.createEl("canvas");
		this.canvas.setAttr("aria-label", "Graph timelapse");

		const snaps = await this.loadSnapshots();
		if (snaps.length === 0) {
			el.empty();
			el.createDiv({ cls: "graph-timelapse-empty", text: "No graph snapshots yet. Run “Graph Timelapse: Take graph snapshot now”." });
			return;
		}
		this.frames = snaps.map(frameOf);

		const ro = new ResizeObserver(() => this.draw(performance.now()));
		ro.observe(el);
		this.register(() => ro.disconnect());

		const io = new IntersectionObserver((entries) => {
			this.visible = entries.some((e) => e.isIntersecting);
			if (this.visible) this.loop();
		});
		io.observe(el);
		this.register(() => io.disconnect());

		if (this.frames.length > 1 && this.cfg.mode !== "still") {
			this.registerDomEvent(this.canvas, "click", () => {
				this.paused = !this.paused;
				if (this.paused) this.pausedAt = performance.now();
				else this.start += performance.now() - this.pausedAt;
				this.loop();
			});
			this.canvas.setAttr("title", "Click to pause / play");
		}

		this.start = performance.now();
		this.loop();
		this.register(() => window.cancelAnimationFrame(this.raf));
	}

	private async loadSnapshots(): Promise<Snapshot[]> {
		const keys = await this.store.keys();
		if (keys.length === 0) return [];
		const c = this.cfg;
		let chosen: string[];
		if (c.mode === "still") {
			const k = c.date === "latest" ? keys[keys.length - 1] : keys.filter((x) => x.startsWith(c.date)).pop() ?? keys[keys.length - 1];
			chosen = [k];
		} else {
			chosen = keys.filter((k) => (!c.from || k >= c.from) && (c.to === "latest" || !c.to || k.slice(0, 10) <= c.to));
			chosen = sample(chosen, c.maxFrames);
		}
		const out: Snapshot[] = [];
		for (const k of chosen) {
			const s = await this.store.load(k);
			if (s) out.push(s);
		}
		return out;
	}

	private loop = () => {
		window.cancelAnimationFrame(this.raf);
		const now = performance.now();
		this.draw(this.paused ? this.pausedAt : now);
		const animating = this.frames.length > 1 && this.cfg.mode !== "still" && !this.paused && this.visible;
		if (animating) this.raf = window.requestAnimationFrame(this.loop);
	};

	private frameAt(time: number): Frame {
		const n = this.frames.length;
		if (n === 1 || this.cfg.mode === "still") return this.frames[n - 1];
		const step = 1000 / this.cfg.speed;
		const play = step * (n - 1);
		const cycle = play + this.cfg.hold * 1000;
		let t = time - this.start;
		if (this.cfg.mode === "loop") t = t % cycle;
		if (t >= play) return this.frames[n - 1];
		const i = Math.floor(t / step);
		return between(this.frames[i], this.frames[i + 1], (t - i * step) / step);
	}

	private draw(time: number) {
		if (!this.frames.length) return;
		const el = this.containerEl;
		const dpr = window.devicePixelRatio || 1;
		const w = Math.max(el.clientWidth, 100);
		const h = this.cfg.height;
		if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
			this.canvas.width = Math.round(w * dpr);
			this.canvas.height = Math.round(h * dpr);
			this.canvas.setCssProps({ width: `${w}px`, height: `${h}px` });
		}
		const ctx = this.canvas.getContext("2d");
		if (!ctx) return;
		const theme = themeColors(el);
		const o: DrawOptions = {
			width: this.canvas.width,
			height: this.canvas.height,
			padding: Math.round(12 * dpr),
			background: theme.background,
			textColor: theme.text,
			font: theme.font,
			stamp: this.cfg.stamp,
		};
		drawFrame(ctx, this.frameAt(time), o);
	}
}
