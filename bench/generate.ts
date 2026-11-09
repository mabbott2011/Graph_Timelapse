/**
 * Sample-data generator for stress-testing Graph Timelapse.
 *
 * For each size tier it simulates a vault growing over time (new notes, new and
 * removed links, deletions, renames, layout drift, and a fresh random
 * rotate/mirror/shift each day like Obsidian's re-layout). It runs every day through the
 * plugin's real buildSnapshot() + serialize(), so the JSON is exactly what the
 * plugin would write. Optionally it also writes the matching .md notes, so
 * each tier is an Obsidian vault you can open.
 *
 *   npm run bench:gen -- --tiers 100,1000 --days 30
 *
 * Output: bench/out/vault-<tier>/ and bench/out/summary.csv
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { performance } from "perf_hooks";
import { buildSnapshot, isSnapshot, serialize, type RawGraph, type Snapshot } from "../src/snapshot";
import { Sequencer, frameShift } from "../src/sequence";
import type { Frame } from "../src/render";
import type { VaultStats } from "../src/stats";

// ---------- options ----------
interface Opts {
	tiers: number[];
	days: number;
	every: number;
	end: string;
	out: string;
	notes: boolean;
	titles: boolean;
	seed: number;
	startFrac: number;
	layoutNoise: boolean;
}

function yesterday(): string {
	const d = new Date();
	d.setDate(d.getDate() - 1);
	return ymd(d);
}
function ymd(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseArgs(argv: string[]): Opts {
	const o: Opts = {
		tiers: [100, 1000, 2500, 5000, 7500, 10000],
		days: 300,
		every: 1,
		end: yesterday(), // not today, so the plugin's own first capture doesn't overwrite the last fake day
		out: "bench/out",
		notes: true,
		titles: false,
		seed: 1,
		startFrac: 0.5,
		layoutNoise: true,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const v = () => argv[++i];
		if (a === "--tiers") o.tiers = v().split(",").map((s) => parseInt(s.replace(/k$/i, "000"), 10)).filter((n) => n > 0);
		else if (a === "--days") o.days = parseInt(v(), 10);
		else if (a === "--every") o.every = parseInt(v(), 10);
		else if (a === "--end") o.end = v();
		else if (a === "--out") o.out = v();
		else if (a === "--no-notes") o.notes = false;
		else if (a === "--titles") o.titles = true;
		else if (a === "--seed") o.seed = parseInt(v(), 10);
		else if (a === "--start-frac") o.startFrac = parseFloat(v());
		else if (a === "--calm-layout") o.layoutNoise = false;
		else if (a === "--help" || a === "-h") {
			console.log(`Options:
  --tiers 100,1000,2500,5000,7500,10000   note counts (final size); "10k" works too
  --days 300          snapshots per tier
  --every 1           days between snapshots
  --end YYYY-MM-DD    date of the last snapshot (default: yesterday)
  --start-frac 0.5    history starts at this fraction of the final size
  --titles            store note titles in snapshots (plugin's "Store note titles")
  --no-notes          only write snapshot JSON, skip the .md notes
  --calm-layout       no Obsidian-style re-layout noise (clusters shuffling, unsettled captures)
  --seed 1            change for a different (still reproducible) vault
  --out bench/out`);
			process.exit(0);
		} else throw new Error(`Unknown option ${a} (try --help)`);
	}
	return o;
}

// ---------- deterministic randomness ----------
function mulberry32(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ---------- vault model ----------
interface Note {
	path: string;
	name: string;
	cluster: number;
	x: number;
	y: number;
}

const GREY = "#b3b3b3ff";
const TAG_COLORS = ["#44cf6eff", "#e0ac00ff", "#a882ffff", "#53dfddff", "#fb464cff"];

class VaultModel {
	notes = new Map<string, Note>();
	/** key "a\0b" (a = linking note, b = target) */
	links = new Map<string, [string, string]>();
	adj = new Map<string, Set<string>>();
	clusterEnds: string[][] = []; // degree-weighted pick lists (may hold dead paths)
	allEnds: string[] = [];
	centers: { x: number; y: number }[] = [];
	private counter = 0;
	rnd: () => number;
	spread: number;

	constructor(public target: number, seed: number) {
		this.rnd = mulberry32(seed);
		const k = Math.max(3, Math.round(Math.sqrt(target) / 2.5));
		const R = 45 * Math.sqrt(target);
		this.spread = R / Math.sqrt(k) / 1.6;
		for (let c = 0; c < k; c++) {
			const t = this.rnd() * Math.PI * 2;
			const d = Math.sqrt(this.rnd()) * R;
			this.centers.push({ x: Math.cos(t) * d, y: Math.sin(t) * d });
			this.clusterEnds.push([]);
		}
	}

	gauss(): number {
		const u = 1 - this.rnd();
		const v = this.rnd();
		return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
	}

	private pick(list: string[]): string | null {
		for (let t = 0; t < 12 && list.length; t++) {
			const p = list[Math.floor(this.rnd() * list.length)];
			if (this.notes.has(p)) return p;
		}
		return null;
	}

	private newPath(cluster: number): { path: string; name: string } {
		const name = `Note ${String(this.counter++).padStart(6, "0")}`;
		return { name, path: `Topic ${String(cluster).padStart(3, "0")}/${name}.md` };
	}

	link(a: string, b: string): boolean {
		if (a === b) return false;
		if (this.links.has(`${a}\0${b}`) || this.links.has(`${b}\0${a}`)) return false;
		this.links.set(`${a}\0${b}`, [a, b]);
		this.adj.get(a)!.add(b);
		this.adj.get(b)!.add(a);
		for (const p of [a, b]) {
			this.clusterEnds[this.notes.get(p)!.cluster].push(p);
			this.allEnds.push(p);
		}
		return true;
	}

	unlink(key: string) {
		const l = this.links.get(key);
		if (!l) return;
		this.links.delete(key);
		this.adj.get(l[0])?.delete(l[1]);
		this.adj.get(l[1])?.delete(l[0]);
	}

	addNote() {
		const c = Math.floor(this.rnd() * this.centers.length);
		const { path, name } = this.newPath(c);
		const orphan = this.rnd() < 0.05;
		const targets: string[] = [];
		if (!orphan && this.notes.size) {
			const m = 1 + Math.floor(this.rnd() * 3);
			for (let i = 0; i < m; i++) {
				const t = this.rnd() < 0.8 ? this.pick(this.clusterEnds[c]) : this.pick(this.allEnds);
				if (t) targets.push(t);
			}
		}
		const anchor = targets.length ? this.notes.get(targets[0])! : this.centers[c];
		const s = targets.length ? 40 : this.spread;
		const note: Note = { path, name, cluster: c, x: anchor.x + this.gauss() * s, y: anchor.y + this.gauss() * s };
		this.notes.set(path, note);
		this.adj.set(path, new Set());
		this.clusterEnds[c].push(path);
		this.allEnds.push(path);
		for (const t of targets) this.link(path, t);
	}

	deleteNote(path: string) {
		for (const [k, l] of this.linksOf(path)) {
			void l;
			this.unlink(k);
		}
		this.notes.delete(path);
		this.adj.delete(path);
	}

	renameNote(path: string) {
		const old = this.notes.get(path)!;
		const { path: np, name } = this.newPath(old.cluster);
		const rel = this.linksOf(path);
		this.notes.set(np, { ...old, path: np, name });
		this.adj.set(np, new Set());
		this.clusterEnds[old.cluster].push(np);
		this.allEnds.push(np);
		for (const [k, [a, b]] of rel) {
			this.unlink(k);
			if (a === path) this.link(np, b);
			else this.link(a, np);
		}
		this.notes.delete(path);
		this.adj.delete(path);
	}

	private linksOf(path: string): [string, [string, string]][] {
		const out: [string, [string, string]][] = [];
		for (const o of this.adj.get(path) ?? []) {
			for (const k of [`${path}\0${o}`, `${o}\0${path}`]) {
				const l = this.links.get(k);
				if (l) out.push([k, l]);
			}
		}
		return out;
	}

	/** One simulated day of vault activity. */
	step(grow: number) {
		const n = this.notes.size;
		const r = () => this.rnd() * 2;
		for (let i = 0; i < grow; i++) this.addNote();
		const paths = [...this.notes.keys()];
		const rand = () => paths[Math.floor(this.rnd() * paths.length)];
		for (let i = 0, d = Math.round(n * 0.001 * r()); i < d; i++) {
			const p = rand();
			if (this.notes.has(p)) this.deleteNote(p);
		}
		for (let i = 0, d = Math.round(n * 0.0005 * r()); i < d; i++) {
			const p = rand();
			if (this.notes.has(p)) this.renameNote(p);
		}
		for (let i = 0, d = Math.round(n * 0.004 * r()); i < d; i++) {
			const a = rand();
			if (!this.notes.has(a)) continue;
			const b = this.rnd() < 0.7 ? this.pick(this.clusterEnds[this.notes.get(a)!.cluster]) : rand();
			if (b && this.notes.has(b)) this.link(a, b);
		}
		const keys = [...this.links.keys()];
		for (let i = 0, d = Math.round(n * 0.001 * r()); i < d && keys.length; i++) this.unlink(keys[Math.floor(this.rnd() * keys.length)]);
		// The force layout never lands in exactly the same place.
		for (const note of this.notes.values()) {
			note.x += this.gauss() * 1.5;
			note.y += this.gauss() * 1.5;
		}
	}

	/**
	 * What the graph view would hand the plugin: positions in a fresh random frame.
	 * With `noisy`, it also mimics Obsidian laying the graph out from scratch:
	 * whole clusters land somewhere a bit different, notes shuffle within them,
	 * and about one capture in four is taken before the layout has spread out.
	 */
	raw(noisy = false): RawGraph {
		const shift = this.centers.map(() => (noisy ? { x: this.gauss() * this.spread * 0.6, y: this.gauss() * this.spread * 0.6 } : { x: 0, y: 0 }));
		const squeeze = noisy && this.rnd() < 0.25 ? 0.55 : 1;
		const jig = noisy ? 12 : 3;
		const t = this.rnd() * Math.PI * 2;
		const c = Math.cos(t);
		const s = Math.sin(t);
		const mirror = this.rnd() < 0.3 ? -1 : 1;
		const dx = (this.rnd() - 0.5) * 600;
		const dy = (this.rnd() - 0.5) * 600;
		const nodes: RawGraph["nodes"] = [];
		for (const n of this.notes.values()) {
			const c0 = this.centers[n.cluster];
			const px = c0.x + (n.x - c0.x) * squeeze + shift[n.cluster].x;
			const py = c0.y + (n.y - c0.y) * squeeze + shift[n.cluster].y;
			const x = (px * squeeze + this.gauss() * jig) * mirror;
			const y = py * squeeze + this.gauss() * jig;
			const deg = this.adj.get(n.path)!.size;
			nodes.push({
				path: n.path,
				x: x * c - y * s + dx,
				y: x * s + y * c + dy,
				r: 8 + Math.min(24, Math.sqrt(deg) * 3),
				color: n.cluster % 3 === 0 ? TAG_COLORS[n.cluster % TAG_COLORS.length] : GREY,
			});
		}
		return { nodes, links: [...this.links.values()], line: { color: "#ffffff40", width: 0.5 } };
	}

	stats(): VaultStats {
		let orphans = 0;
		for (const s of this.adj.values()) if (!s.size) orphans++;
		return { notes: this.notes.size, links: this.links.size, orphans, unresolved: Math.floor(this.notes.size * 0.02) };
	}

	writeNotes(root: string) {
		const outgoing = new Map<string, string[]>();
		for (const [a, b] of this.links.values()) {
			if (!outgoing.has(a)) outgoing.set(a, []);
			outgoing.get(a)!.push(this.notes.get(b)!.name);
		}
		const dirs = new Set<string>();
		let i = 0;
		for (const n of this.notes.values()) {
			const dir = join(root, n.path.split("/")[0]);
			if (!dirs.has(dir)) {
				mkdirSync(dir, { recursive: true });
				dirs.add(dir);
			}
			const links = (outgoing.get(n.path) ?? []).map((t) => `- [[${t}]]`);
			if (i++ % 50 === 0) links.push(`- [[Missing ${i}]]`); // ~2% unresolved links
			writeFileSync(join(root, n.path), `# ${n.name}\n\nGenerated test note (cluster ${n.cluster}).\n\n${links.join("\n")}\n`);
		}
	}
}

// ---------- run ----------
interface Row {
	tier: number;
	snapshots: number;
	finalNotes: number;
	finalLinks: number;
	avgKB: number;
	maxKB: number;
	totalMB: number;
	buildAvgMs: number;
	buildMaxMs: number;
	serializeAvgMs: number;
	parseLastMs: number;
	genSeconds: number;
	/** How far notes jump between frames, % of the frame: as recorded vs. steady layout + skip unchanged. */
	jitterRawPct: number;
	jitterSteadyPct: number;
}

function addDays(key: string, d: number): string {
	const [y, m, dd] = key.split("-").map(Number);
	return ymd(new Date(y, m - 1, dd + d));
}

function copyPlugin(vault: string) {
	const dir = join(vault, ".obsidian", "plugins", "graph-timelapse");
	const files = ["main.js", "manifest.json", "styles.css"].filter((f) => existsSync(f));
	if (!files.includes("main.js")) return false;
	mkdirSync(dir, { recursive: true });
	for (const f of files) copyFileSync(f, join(dir, f));
	writeFileSync(join(vault, ".obsidian", "community-plugins.json"), JSON.stringify(["graph-timelapse"]));
	return true;
}

function runTier(tier: number, o: Opts): Row {
	const t0 = performance.now();
	const vault = join(o.out, `vault-${tier}`);
	rmSync(vault, { recursive: true, force: true });
	const dataDir = join(vault, "_attachments", "graph-data");
	mkdirSync(dataDir, { recursive: true });

	const model = new VaultModel(tier, o.seed * 7919 + tier);
	const start = Math.max(1, Math.round(tier * o.startFrac));
	while (model.notes.size < start) model.addNote();
	let acc = 0;

	const firstKey = addDays(o.end, -(o.days - 1) * o.every);
	let prev: Snapshot | null = null;
	let lastFile = "";
	let bytes = 0;
	let maxBytes = 0;
	let buildSum = 0;
	let buildMax = 0;
	let serSum = 0;
	// Playback as recorded vs. with the steady layout, to measure jumpiness.
	const seqRaw = new Sequencer({ skipUnchanged: false, steady: 0 });
	const seqSteady = new Sequencer();
	const shifts = { raw: [0, 0], steady: [0, 0] };
	const last: { raw: Frame | null; steady: Frame | null } = { raw: null, steady: null };
	const track = (kind: "raw" | "steady", frames: Frame[]) => {
		for (const f of frames) {
			const v = last[kind] ? frameShift(last[kind]!, f) : null;
			if (v !== null) {
				shifts[kind][0] += v;
				shifts[kind][1]++;
			}
			last[kind] = f;
		}
	};

	for (let d = 0; d < o.days; d++) {
		if (d > 0) {
			// Aim for the final size on the last day, net of deletions.
			const perDay = Math.max(0, (tier - model.notes.size) / (o.days - d));
			acc += perDay * (0.5 + model.rnd());
			const grow = Math.floor(acc);
			acc -= grow;
			model.step(grow);
		}
		const key = addDays(firstKey, d * o.every);
		const raw = model.raw(o.layoutNoise);
		const b0 = performance.now();
		const snap = buildSnapshot(key, raw, prev, model.stats(), o.titles);
		const b1 = performance.now();
		snap.takenAt = new Date(`${key}T00:05:00`).toISOString();
		const text = serialize(snap);
		const b2 = performance.now();
		lastFile = join(dataDir, `${key}.json`);
		writeFileSync(lastFile, text);
		buildSum += b1 - b0;
		buildMax = Math.max(buildMax, b1 - b0);
		serSum += b2 - b1;
		const sz = Buffer.byteLength(text);
		bytes += sz;
		maxBytes = Math.max(maxBytes, sz);
		prev = snap;
		track("raw", seqRaw.push(snap));
		track("steady", seqSteady.push(snap));
		if (d % 25 === 0 || d === o.days - 1) process.stdout.write(`\r  ${tier} notes: day ${d + 1}/${o.days}  (${model.notes.size} notes, ${(bytes / 1048576).toFixed(1)} MB)   `);
	}
	process.stdout.write("\n");
	track("raw", seqRaw.flush());
	track("steady", seqSteady.flush());

	// How long the plugin's load() would take on the newest (biggest) file.
	const p0 = performance.now();
	const parsed: unknown = JSON.parse(readFileSync(lastFile, "utf8"));
	const ok = isSnapshot(parsed);
	const parseMs = performance.now() - p0;
	if (!ok) throw new Error(`Generated file failed isSnapshot(): ${lastFile}`);

	if (o.notes) {
		model.writeNotes(vault);
		writeFileSync(
			join(vault, "Timelapse.md"),
			"# Timelapse\n\n```graph-timelapse\nmode: loop\nspeed: 4\nheight: 600\n```\n\n## Latest\n\n```graph-timelapse\nmode: still\ndate: latest\n```\n",
		);
		copyPlugin(vault);
	}

	const s = model.stats();
	return {
		tier,
		snapshots: o.days,
		finalNotes: s.notes,
		finalLinks: s.links,
		avgKB: +(bytes / o.days / 1024).toFixed(1),
		maxKB: +(maxBytes / 1024).toFixed(1),
		totalMB: +(bytes / 1048576).toFixed(1),
		buildAvgMs: +(buildSum / o.days).toFixed(2),
		buildMaxMs: +buildMax.toFixed(2),
		serializeAvgMs: +(serSum / o.days).toFixed(2),
		parseLastMs: +parseMs.toFixed(2),
		genSeconds: +((performance.now() - t0) / 1000).toFixed(1),
		jitterRawPct: +(shifts.raw[0] / Math.max(shifts.raw[1], 1)).toFixed(2),
		jitterSteadyPct: +(shifts.steady[0] / Math.max(shifts.steady[1], 1)).toFixed(2),
	};
}

function main() {
	const o = parseArgs(process.argv.slice(2));
	const est = o.tiers.reduce((sum, t) => sum + t * ((1 + o.startFrac) / 2) * o.days * 110, 0) / 1048576;
	console.log(`Graph Timelapse sample data: tiers ${o.tiers.join(", ")} · ${o.days} snapshots each · ending ${o.end}`);
	console.log(`Rough disk estimate: ~${est < 1024 ? est.toFixed(0) + " MB" : (est / 1024).toFixed(1) + " GB"} → ${o.out}/\n`);
	mkdirSync(o.out, { recursive: true });
	const rows: Row[] = [];
	for (const t of o.tiers) rows.push(runTier(t, o));
	console.log();
	console.table(rows);
	const cols = Object.keys(rows[0]) as (keyof Row)[];
	writeFileSync(join(o.out, "summary.csv"), [cols.join(","), ...rows.map((r) => cols.map((c) => r[c]).join(","))].join("\n") + "\n");
	console.log(`\nVaults: ${o.out}/vault-<tier>/  ·  summary: ${o.out}/summary.csv`);
}

main();
