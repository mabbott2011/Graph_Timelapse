import { App, Modal, Notice, Setting } from "obsidian";
import type GraphTimelapsePlugin from "./main";
import type { Frame } from "./render";
import { DEFAULT_STEADY, Sequencer, autoSpeed } from "./sequence";
import type { SnapshotStore } from "./snapshot";
import { PRESETS } from "./settings";
import { VideoFormat, browserProbe, chooseEngine, planVideo, recordVideo } from "./video";

export interface ExportChoice {
	format: VideoFormat;
	from: string;
	to: string;
	width: number;
	height: number;
	/** Snapshots per second; 0 = auto. */
	speed: number;
	hold: number;
	stamp: boolean;
	fps: number;
	steady: number;
	skipUnchanged: boolean;
}

const FPS = 30;

/** Snapshot keys between two dates (inclusive), by day. */
export function keysInRange(keys: string[], from: string, to: string): string[] {
	return keys.filter((k) => k.slice(0, 10) >= from.slice(0, 10) && k.slice(0, 10) <= to.slice(0, 10));
}

export class ExportModal extends Modal {
	private c: ExportChoice;
	private summaryEl!: HTMLElement;

	constructor(
		app: App,
		private plugin: GraphTimelapsePlugin,
		private keys: string[],
	) {
		super(app);
		const s = plugin.settings;
		this.c = {
			format: "mp4",
			from: keys[0],
			to: keys[keys.length - 1],
			width: s.width,
			height: s.height,
			speed: 0,
			hold: 2,
			stamp: s.stamp,
			fps: FPS,
			steady: DEFAULT_STEADY,
			skipUnchanged: true,
		};
	}

	onOpen() {
		const { contentEl } = this;
		const c = this.c;
		this.titleEl.setText("Export timelapse video");

		new Setting(contentEl)
			.setName("Format")
			.setDesc("MP4 plays everywhere. WebM is smaller, for the web.")
			.addDropdown((d) =>
				d
					.addOptions({ mp4: "MP4", webm: "WebM" })
					.setValue(c.format)
					.onChange((v) => {
						c.format = v as VideoFormat;
						this.update();
					}),
			);

		const dates = Object.fromEntries(this.keys.map((k) => [k, k.replace("_", " ")]));
		new Setting(contentEl).setName("From").addDropdown((d) =>
			d
				.addOptions(dates)
				.setValue(c.from)
				.onChange((v) => {
					c.from = v;
					this.update();
				}),
		);
		new Setting(contentEl).setName("To").addDropdown((d) =>
			d
				.addOptions(dates)
				.setValue(c.to)
				.onChange((v) => {
					c.to = v;
					this.update();
				}),
		);

		const shapes: Record<string, string> = { current: `Same as image settings (${c.width} × ${c.height})` };
		for (const p of PRESETS) shapes[p.id] = p.label;
		new Setting(contentEl).setName("Shape").addDropdown((d) =>
			d
				.addOptions(shapes)
				.setValue("current")
				.onChange((v) => {
					const p = PRESETS.find((x) => x.id === v);
					c.width = p ? p.w : this.plugin.settings.width;
					c.height = p ? p.h : this.plugin.settings.height;
					this.update();
				}),
		);

		const speeds: Record<string, string> = { "0": "Auto (about 15 s)" };
		for (const v of [1, 2, 3, 4, 6, 8, 12, 16, 24, 30]) speeds[String(v)] = `${v} per second`;
		new Setting(contentEl)
			.setName("Speed")
			.setDesc("Snapshots per second. Auto plays short histories slowly and speeds up long ones (1–8 per second).")
			.addDropdown((d) =>
				d
					.addOptions(speeds)
					.setValue(String(c.speed))
					.onChange((v) => {
						c.speed = Number(v);
						this.update();
					}),
			);
		new Setting(contentEl)
			.setName("Hold last frame")
			.setDesc("Seconds.")
			.addSlider((sl) =>
				sl
					.setLimits(0, 10, 1)
					.setValue(c.hold)
					.onChange((v) => {
						c.hold = v;
						this.update();
					}),
			);
		new Setting(contentEl)
			.setName("Steady layout")
			.setDesc("Obsidian lays the graph out from scratch each time, so notes jump around. Higher keeps each note near where it was. 0 = as recorded.")
			.addSlider((sl) =>
				sl
					.setLimits(0, 0.95, 0.05)
					.setValue(c.steady)
					.onChange((v) => (c.steady = v)),
			);
		new Setting(contentEl)
			.setName("Skip unchanged snapshots")
			.setDesc("Fold snapshots where no note or link changed into the one before.")
			.addToggle((t) =>
				t.setValue(c.skipUnchanged).onChange((v) => {
					c.skipUnchanged = v;
					this.update();
				}),
			);
		new Setting(contentEl).setName("Stamp date and counts").addToggle((t) => t.setValue(c.stamp).onChange((v) => (c.stamp = v)));

		this.summaryEl = contentEl.createDiv({ cls: "setting-item-description graph-timelapse-export-summary" });
		this.update();

		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("Export")
				.setCta()
				.onClick(() => {
					this.close();
					void exportVideo(this.plugin, { ...c });
				}),
		);
	}

	private update() {
		const n = keysInRange(this.keys, this.c.from, this.c.to).length;
		const speed = this.c.speed || autoSpeed(n);
		const plan = planVideo(n, this.c.fps, speed, this.c.hold);
		this.summaryEl.setText(
			n < 2
				? "Pick a range with at least two snapshots."
				: `${n} snapshots at ${speed} per second${this.c.speed ? "" : " (auto)"} → up to ${Math.ceil(plan.seconds)} s of video${this.c.skipUnchanged ? " (less if some are unchanged)" : ""} at ${this.c.width} × ${this.c.height}. ` +
						`Includes a small “made with Graph Timelapse” credit.`,
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Render the chosen range and save it next to the PNG keyframes. */
export async function exportVideo(plugin: GraphTimelapsePlugin, c: ExportChoice) {
	const picked = await chooseEngine(c.format, c.width, c.height, browserProbe());
	if (!picked) {
		new Notice("Graph Timelapse: this device can't encode MP4 or WebM video.");
		return;
	}
	const keys = keysInRange(await plugin.store.keys(), c.from, c.to);
	if (keys.length < 2) {
		new Notice("Graph Timelapse: pick a range with at least two snapshots.");
		return;
	}
	if (plugin.exporting) {
		new Notice("Graph Timelapse: an export is already running.");
		return;
	}
	plugin.exporting = true;

	let cancelled = false;
	const msg = createFragment();
	const status = msg.createSpan({ text: "Graph Timelapse: exporting video… 0% " });
	const cancel = msg.createEl("button", { text: "Cancel" });
	cancel.addEventListener("click", () => {
		cancelled = true;
		status.setText("Graph Timelapse: cancelling… ");
	});
	const notice = new Notice(msg, 0);
	const started = performance.now();
	try {
		if (picked.fellBack) new Notice(`Graph Timelapse: ${c.format.toUpperCase()} isn't available here, saving ${picked.ext.toUpperCase()} instead.`);
		const draw = { ...plugin.drawOptions(), width: c.width, height: c.height, stamp: c.stamp };
		const blob = await recordVideo({
			count: keys.length,
			frames: framesFor(plugin.store, keys, new Sequencer({ skipUnchanged: c.skipUnchanged, steady: c.steady })),
			draw,
			fps: c.fps,
			speed: c.speed || autoSpeed(keys.length),
			holdSeconds: c.hold,
			engine: picked,
			onProgress: (d, t) => {
				if (!cancelled) status.setText(`Graph Timelapse: exporting video… ${Math.round((d / t) * 100)}% `);
			},
			isCancelled: () => cancelled,
		});
		const name = `graph-timelapse_${keys[0]}_${keys[keys.length - 1]}.${picked.ext}`;
		const path = await plugin.writeFile(name, await blob.arrayBuffer());
		notice.hide();
		const secs = ((performance.now() - started) / 1000).toFixed(0);
		new Notice(`Graph Timelapse: saved ${path} (${(blob.size / 1048576).toFixed(1)} MB, ${secs} s)`);
	} catch (e) {
		notice.hide();
		if ((e as Error).message === "Cancelled") new Notice("Graph Timelapse: export cancelled.");
		else {
			console.error("[graph-timelapse]", e);
			new Notice(`Graph Timelapse: export failed — ${(e as Error).message}`);
		}
	} finally {
		plugin.exporting = false;
	}
}

/** Streams snapshots from disk through the sequencer, two at a time, without filling the playback cache. */
async function* framesFor(store: SnapshotStore, keys: string[], seq: Sequencer): AsyncGenerator<Frame> {
	for (const k of keys) {
		const s = await store.load(k, false);
		if (s) yield* seq.push(s);
	}
	yield* seq.flush();
}
