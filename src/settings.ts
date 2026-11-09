import { App, PluginSettingTab, Setting } from "obsidian";
import type GraphTimelapsePlugin from "./main";

export const FUNDING_URL = "https://buymeacoffee.com/shadyknollm";

export const PRESETS = [
	{ id: "square", label: "Square 1:1 — 1080×1080 (recommended)", w: 1080, h: 1080 },
	{ id: "square-small", label: "Square 1:1 — 800×800 (smaller files)", w: 800, h: 800 },
	{ id: "portrait", label: "Portrait 4:5 — 1080×1350 (social feeds)", w: 1080, h: 1350 },
	{ id: "vertical", label: "Vertical 9:16 — 1080×1920 (Shorts, Reels, TikTok)", w: 1080, h: 1920 },
	{ id: "wide", label: "Wide 16:9 — 1920×1080 (YouTube, slides)", w: 1920, h: 1080 },
];

export const UNITS = ["minutes", "hours", "days", "weeks", "months", "years"] as const;
export type Unit = (typeof UNITS)[number];

export interface GraphTimelapseSettings {
	autoSnapshot: boolean;
	/** How often to record graph data (JSON). */
	dataEvery: number;
	dataUnit: Unit;
	dataFolder: string;
	/** Store note paths in snapshots. Off: notes are stored as pseudonymous ids (path hashes). */
	includeTitles: boolean;
	/** How often to also save a PNG keyframe. 0 = never. */
	pngEvery: number;
	pngUnit: Unit;
	/** "HH:mm" — the first time Obsidian is open at or after this, take the day's snapshot. */
	snapshotTime: string;
	folder: string;
	/** {{date}} is replaced with YYYY-MM-DD. ".png" is added. */
	fileName: string;
	width: number;
	height: number;
	padding: number;
	settleSeconds: number;
	maxWaitSeconds: number;
	background: string;
	stamp: boolean;
	logStats: boolean;
	statsFile: string;
}

export const DEFAULT_SETTINGS: GraphTimelapseSettings = {
	autoSnapshot: true,
	dataEvery: 1,
	dataUnit: "days",
	dataFolder: "_attachments/graph-data",
	includeTitles: false,
	pngEvery: 1,
	pngUnit: "weeks",
	snapshotTime: "00:00",
	folder: "_attachments",
	fileName: "graph-{{date}}",
	width: 1080,
	height: 1080,
	padding: 40,
	settleSeconds: 5,
	maxWaitSeconds: 30,
	background: "",
	stamp: true,
	logStats: true,
	statsFile: "_attachments/graph-stats.csv",
};

export class GraphTimelapseSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: GraphTimelapsePlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		containerEl.empty();

		new Setting(containerEl)
			.setName("Take a snapshot now")
			.setDesc(`Records graph data and saves a PNG. Last data: ${this.plugin.lastDataAt ?? "never"} · last image: ${this.plugin.lastPngAt ?? "never"}`)
			.addButton((b) =>
				b
					.setButtonText("Snapshot")
					.setCta()
					.onClick(async () => {
						await this.plugin.takeSnapshot(true);
						this.display();
					}),
			);

		new Setting(containerEl).setName("Schedule").setHeading();

		new Setting(containerEl)
			.setName("Automatic snapshots")
			.setDesc("Record the graph on the schedule below while the vault is open.")
			.addToggle((t) => t.setValue(s.autoSnapshot).onChange(async (v) => ((s.autoSnapshot = v), await save())));

		const every = (name: string, desc: string, n: () => number, u: () => Unit, set: (n: number, u: Unit) => void, allowNever: boolean) =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((t) => {
					t.inputEl.type = "number";
					t.inputEl.addClass("graph-timelapse-number");
					t.setValue(String(n())).onChange(async (v) => {
						const x = parseInt(v, 10);
						if (isFinite(x) && x >= (allowNever ? 0 : 1)) {
							set(x, u());
							await save();
						}
					});
				})
				.addDropdown((d) => {
					for (const unit of UNITS) d.addOption(unit, unit);
					d.setValue(u()).onChange(async (v) => {
						set(n(), v as Unit);
						await save();
					});
				});

		every(
			"Record graph data every",
			"Small JSON files: positions, sizes, colours and links. The timelapse is built from these. Minimum 30 minutes (each one briefly opens the graph view).",
			() => s.dataEvery,
			() => s.dataUnit,
			(n, u) => ((s.dataEvery = n), (s.dataUnit = u)),
			false,
		);
		every(
			"Save a PNG every",
			"Image keyframes, drawn from the data. 0 = never. Any day can still be rendered later with “Render PNG from a snapshot”.",
			() => s.pngEvery,
			() => s.pngUnit,
			(n, u) => ((s.pngEvery = n), (s.pngUnit = u)),
			true,
		);

		new Setting(containerEl)
			.setName("Time of day")
			.setDesc("For day-or-longer schedules: 24-hour HH:mm. 00:00 means the first time you open the vault that day.")
			.addText((t) =>
				t
					.setPlaceholder("00:00")
					.setValue(s.snapshotTime)
					.onChange(async (v) => {
						if (/^([01]\d|2[0-3]):[0-5]\d$/.test(v.trim())) {
							s.snapshotTime = v.trim();
							await save();
						}
					}),
			);

		new Setting(containerEl).setName("Data").setHeading();

		new Setting(containerEl)
			.setName("Data folder")
			.setDesc("Where snapshot JSON files go. Obsidian doesn't show .json files, so they won't clutter the vault.")
			.addText((t) => t.setValue(s.dataFolder).onChange(async (v) => ((s.dataFolder = v.trim() || DEFAULT_SETTINGS.dataFolder), this.plugin.store.invalidate(), await save())));

		new Setting(containerEl)
			.setName("Store note titles")
			.setDesc("Off: notes are saved as pseudonymous ids (a hash of the note path), which is enough to draw the graph. Someone who can guess a path could still match it. On: note paths are saved as-is. Leave off if the vault is shared or public.")
			.addToggle((t) => t.setValue(s.includeTitles).onChange(async (v) => ((s.includeTitles = v), await save())));

		new Setting(containerEl).setName("Image").setHeading();

		new Setting(containerEl)
			.setName("Folder")
			.setDesc("Where snapshots are saved. Created if missing.")
			.addText((t) => t.setValue(s.folder).onChange(async (v) => ((s.folder = v.trim()), await save())));

		new Setting(containerEl)
			.setName("File name")
			.setDesc("{{date}} becomes YYYY-MM-DD. .png is added. Taking a second snapshot the same day overwrites the first.")
			.addText((t) => t.setValue(s.fileName).onChange(async (v) => ((s.fileName = v.trim() || DEFAULT_SETTINGS.fileName), await save())));

		const preset = PRESETS.find((p) => p.w === s.width && p.h === s.height)?.id ?? "custom";
		new Setting(containerEl)
			.setName("Shape")
			.setDesc("Square suits a round graph and works everywhere. Keep it fixed so snapshots line up as a timelapse.")
			.addDropdown((d) => {
				for (const p of PRESETS) d.addOption(p.id, p.label);
				d.addOption("custom", "Custom");
				d.setValue(preset).onChange(async (v) => {
					const p = PRESETS.find((x) => x.id === v);
					if (p) {
						s.width = p.w;
						s.height = p.h;
						await save();
					}
					this.display();
				});
			});

		if (preset === "custom") {
			new Setting(containerEl)
				.setName("Size")
				.setDesc("Width × height in pixels.")
				.addText((t) => t.setValue(String(s.width)).onChange(async (v) => ((s.width = toInt(v, s.width, 320, 4000)), await save())))
				.addText((t) => t.setValue(String(s.height)).onChange(async (v) => ((s.height = toInt(v, s.height, 240, 4000)), await save())));
		}

		new Setting(containerEl)
			.setName("Padding")
			.setDesc("Empty border around the graph, in pixels.")
			.addText((t) => t.setValue(String(s.padding)).onChange(async (v) => ((s.padding = toInt(v, s.padding, 0, 1000)), await save())));

		new Setting(containerEl)
			.setName("Background")
			.setDesc("CSS color like #1e1e1e. Leave empty to use your theme's background.")
			.addText((t) => t.setPlaceholder("theme").setValue(s.background).onChange(async (v) => ((s.background = v.trim()), await save())));

		new Setting(containerEl)
			.setName("Stamp date and counts")
			.setDesc("Write the date, note, link, orphan and unresolved counts in the corner.")
			.addToggle((t) => t.setValue(s.stamp).onChange(async (v) => ((s.stamp = v), await save())));

		new Setting(containerEl)
			.setName("Layout settle time")
			.setDesc("Minimum and maximum seconds to wait for the graph to stop moving before capturing.")
			.addText((t) => t.setValue(String(s.settleSeconds)).onChange(async (v) => ((s.settleSeconds = toInt(v, s.settleSeconds, 1, 120)), await save())))
			.addText((t) => t.setValue(String(s.maxWaitSeconds)).onChange(async (v) => ((s.maxWaitSeconds = toInt(v, s.maxWaitSeconds, 1, 300)), await save())));

		new Setting(containerEl).setName("Stats").setHeading();

		new Setting(containerEl)
			.setName("Log counts to CSV")
			.setDesc("One row per day: date, notes, links, orphans, unresolved.")
			.addToggle((t) => t.setValue(s.logStats).onChange(async (v) => ((s.logStats = v), await save())));

		new Setting(containerEl)
			.setName("CSV file")
			.addText((t) => t.setValue(s.statsFile).onChange(async (v) => ((s.statsFile = v.trim() || DEFAULT_SETTINGS.statsFile), await save())));

		new Setting(containerEl).setName("Support").setHeading();

		new Setting(containerEl)
			.setName("Buy me a coffee")
			.setDesc("Graph Timelapse is free. If it's useful to you, a coffee keeps Shady Knoll Labs building.")
			.addButton((b) => {
				b.setButtonText("☕ Buy me a coffee").onClick(() => window.open(FUNDING_URL));
				b.buttonEl.addClass("graph-timelapse-coffee");
			});
	}
}

function toInt(v: string, fallback: number, min: number, max: number): number {
	const n = parseInt(v, 10);
	if (!isFinite(n)) return fallback;
	return Math.min(Math.max(n, min), max);
}
