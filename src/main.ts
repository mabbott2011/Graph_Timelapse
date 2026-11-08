import { App, Notice, Plugin, SuggestModal, TFile, moment, normalizePath } from "obsidian";
import { captureGraph } from "./capture";
import { TimelapseEmbed, parseConfig } from "./embed";
import { DrawOptions, snapshotToPng, themeColors } from "./render";
import { DEFAULT_SETTINGS, GraphTimelapseSettings, GraphTimelapseSettingTab, Unit } from "./settings";
import { Snapshot, SnapshotStore, buildSnapshot } from "./snapshot";
import { VaultStats, collectStats, formatStats } from "./stats";

interface StoredData {
	settings?: Partial<GraphTimelapseSettings>;
	lastDataAt?: string | null;
	lastPngAt?: string | null;
	/** v0.1 field, migrated to lastDataAt/lastPngAt. */
	lastSnapshotDate?: string | null;
}

/** Build timestamp, set by esbuild — shows in last-capture.json which build actually ran. */
declare const __BUILD__: string;

const CHECK_EVERY_MS = 5 * 60 * 1000;
const STARTUP_DELAY_MS = 20 * 1000;
const MIN_DATA_INTERVAL_MIN = 30;
const CSV_HEADER = "date,notes,links,orphans,unresolved";

export default class GraphTimelapsePlugin extends Plugin {
	settings: GraphTimelapseSettings = { ...DEFAULT_SETTINGS };
	lastDataAt: string | null = null;
	lastPngAt: string | null = null;
	store!: SnapshotStore;
	private running = false;

	async onload() {
		await this.loadStored();
		this.store = new SnapshotStore(this.app, () => this.settings.dataFolder);
		this.addSettingTab(new GraphTimelapseSettingTab(this.app, this));

		this.addCommand({
			id: "take-snapshot",
			name: "Take graph snapshot now",
			callback: () => void this.run({ data: true, png: true, manual: true }),
		});
		this.addCommand({
			id: "render-png",
			name: "Render PNG from a snapshot",
			callback: () => void this.pickAndRender(),
		});

		this.registerMarkdownCodeBlockProcessor("graph-timelapse", (src, el, ctx) => {
			ctx.addChild(new TimelapseEmbed(el, parseConfig(src), this.store));
		});

		this.app.workspace.onLayoutReady(() => {
			// Give Obsidian (and the Git plugin's pull-on-startup) a moment first.
			const t = window.setTimeout(() => void this.checkSchedule(), STARTUP_DELAY_MS);
			this.register(() => window.clearTimeout(t));
			this.registerInterval(window.setInterval(() => void this.checkSchedule(), CHECK_EVERY_MS));
		});
	}

	private async pickAndRender() {
		const keys = await this.store.keys();
		if (!keys.length) {
			new Notice("Graph Timelapse: no snapshots yet.");
			return;
		}
		new SnapshotPicker(this.app, [...keys].reverse(), (k) => void this.renderPngFor(k, true)).open();
	}

	/** Next time something on an "every n unit" schedule is due. */
	private nextDue(last: string | null, n: number, unit: Unit, minMinutes = 0): moment.Moment | null {
		if (n <= 0) return null;
		if (!last) return moment(0);
		const base = moment(last);
		if (unit === "minutes" || unit === "hours") {
			const due = base.clone().add(n, unit);
			const min = base.clone().add(minMinutes, "minutes");
			return moment.max(due, min);
		}
		const [h, m] = this.settings.snapshotTime.split(":").map((x) => parseInt(x, 10));
		return base
			.clone()
			.startOf("day")
			.add(n, unit)
			.add(h || 0, "hours")
			.add(m || 0, "minutes");
	}

	async checkSchedule() {
		if (!this.settings.autoSnapshot || this.running) return;
		const s = this.settings;
		const now = moment();
		const dataDue = this.nextDue(this.lastDataAt, s.dataEvery, s.dataUnit, MIN_DATA_INTERVAL_MIN);
		const pngDue = this.nextDue(this.lastPngAt, s.pngEvery, s.pngUnit);
		const wantData = !!dataDue && !now.isBefore(dataDue);
		const wantPng = !!pngDue && !now.isBefore(pngDue);
		if (wantData || wantPng) await this.run({ data: wantData, png: wantPng, manual: false });
	}

	/** Snapshot key: one per day for day-or-longer schedules, otherwise per minute. */
	private keyFor(t: moment.Moment): string {
		const sub = this.settings.dataUnit === "minutes" || this.settings.dataUnit === "hours";
		return t.format(sub ? "YYYY-MM-DD_HHmm" : "YYYY-MM-DD");
	}

	async run(want: { data: boolean; png: boolean; manual: boolean }) {
		if (this.running) return;
		this.running = true;
		const now = moment();
		const notice = want.data ? new Notice("Graph Timelapse: recording graph…", 0) : null;
		const done: string[] = [];
		try {
			const s = this.settings;
			let snap: Snapshot | null = null;

			if (want.data) {
				const stats = collectStats(this.app);
				const result = await captureGraph(this.app, {
					width: s.width,
					height: s.height,
					padding: s.padding,
					settleMs: s.settleSeconds * 1000,
					maxWaitMs: Math.max(s.maxWaitSeconds, s.settleSeconds) * 1000,
					background: s.background,
					stamp: s.stamp ? `${now.format("YYYY-MM-DD")} · ${formatStats(stats)}` : null,
					pixiPng: want.png ? "if-no-data" : "never",
				});
				await this.writeDebug({ at: now.toISOString(), build: __BUILD__, version: this.manifest.version, method: result.method, steps: result.debug });

				if (result.graph) {
					const prev = await this.store.latest();
					snap = buildSnapshot(this.keyFor(now), result.graph, prev, stats, s.includeTitles);
					await this.store.save(snap);
					done.push(`data ${snap.key}`);
				} else if (result.png) {
					// Couldn't read the graph data: keep the old-style image so the day isn't lost.
					done.push(await this.writeImage(this.keyFor(now), result.png));
					this.lastPngAt = now.toISOString();
					want.png = false;
				} else {
					throw new Error("Couldn't read the graph view.");
				}
				if (s.logStats) await this.logStats(now.format("YYYY-MM-DD"), stats);
				this.lastDataAt = now.toISOString();
			}

			if (want.png) {
				snap = snap ?? (await this.store.latest());
				if (snap) {
					done.push(await this.writePng(snap));
					this.lastPngAt = now.toISOString();
				}
			}

			await this.saveStored();
			notice?.hide();
			if (want.manual) new Notice(`Graph Timelapse: saved ${done.join(", ") || "nothing"}`);
		} catch (e) {
			notice?.hide();
			console.error("[graph-timelapse]", e);
			new Notice(`Graph Timelapse: snapshot failed — ${(e as Error).message}`);
		} finally {
			this.running = false;
		}
	}

	private drawOptions(): DrawOptions {
		const s = this.settings;
		const theme = themeColors();
		return {
			width: s.width,
			height: s.height,
			padding: s.padding,
			background: s.background.trim() || theme.background,
			textColor: theme.text,
			font: theme.font,
			stamp: s.stamp,
		};
	}

	private async writePng(snap: Snapshot): Promise<string> {
		return this.writeImage(snap.key, await snapshotToPng(snap, this.drawOptions()));
	}

	async renderPngFor(key: string, manual: boolean) {
		const snap = await this.store.load(key);
		if (!snap) {
			new Notice(`Graph Timelapse: couldn't read snapshot ${key}`);
			return;
		}
		const path = await this.writePng(snap);
		if (manual) new Notice(`Graph Timelapse: saved ${path}`);
	}

	/** Troubleshooting record of the last capture, kept in the plugin's own folder. */
	private async writeDebug(info: unknown) {
		try {
			const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
			await this.app.vault.adapter.write(normalizePath(`${dir}/last-capture.json`), JSON.stringify(info, null, 2));
		} catch {
			/* debugging aid only */
		}
	}

	private async ensureFolder(folder: string) {
		if (!folder || folder === "/") return;
		if (!this.app.vault.getAbstractFileByPath(folder)) {
			await this.app.vault.createFolder(folder).catch(() => undefined);
		}
	}

	private async writeImage(key: string, png: ArrayBuffer): Promise<string> {
		const folder = normalizePath(this.settings.folder || "/");
		await this.ensureFolder(folder);
		const name = this.settings.fileName.split("{{date}}").join(key) + ".png";
		const path = normalizePath(folder === "/" ? name : `${folder}/${name}`);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, png);
		else await this.app.vault.createBinary(path, png);
		return path;
	}

	private async logStats(date: string, st: VaultStats) {
		const path = normalizePath(this.settings.statsFile);
		const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		await this.ensureFolder(folder);
		const adapter = this.app.vault.adapter;
		let lines: string[] = [CSV_HEADER];
		if (await adapter.exists(path)) {
			lines = (await adapter.read(path)).split(/\r?\n/).filter((l) => l.trim() !== "");
			if (lines[0] !== CSV_HEADER) lines.unshift(CSV_HEADER);
			// One row per day: a later snapshot the same day replaces it.
			lines = lines.filter((l) => !l.startsWith(date + ","));
		}
		lines.push([date, st.notes, st.links, st.orphans, st.unresolved].join(","));
		await adapter.write(path, lines.join("\n") + "\n");
	}

	private async loadStored() {
		const data = ((await this.loadData()) ?? {}) as StoredData;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings ?? {});
		const legacy = data.lastSnapshotDate ? moment(data.lastSnapshotDate, "YYYY-MM-DD").toISOString() : null;
		this.lastDataAt = data.lastDataAt ?? null; // v0.1 saved images only, so data starts fresh
		this.lastPngAt = data.lastPngAt ?? legacy;
	}

	private async saveStored() {
		const data: StoredData = { settings: this.settings, lastDataAt: this.lastDataAt, lastPngAt: this.lastPngAt };
		await this.saveData(data);
	}

	async saveSettings() {
		await this.saveStored();
	}

	/** Kept for the settings tab's button. */
	async takeSnapshot(manual: boolean) {
		await this.run({ data: true, png: true, manual });
	}
}

class SnapshotPicker extends SuggestModal<string> {
	constructor(
		app: App,
		private keys: string[],
		private onPick: (k: string) => void,
	) {
		super(app);
		this.setPlaceholder("Pick a snapshot to render as PNG");
	}
	getSuggestions(q: string): string[] {
		return this.keys.filter((k) => k.includes(q.trim()));
	}
	renderSuggestion(k: string, el: HTMLElement) {
		el.setText(k);
	}
	onChooseSuggestion(k: string) {
		this.onPick(k);
	}
}
