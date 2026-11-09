/**
 * How much does a timelapse jump around? Reads a folder of snapshots (yours, or
 * a generated vault's) and reports frame-to-frame movement of notes that didn't
 * change, as % of the frame size, for several "steady" settings.
 *
 *   npm run bench:jitter -- "C:/path/to/vault/_attachments/graph-data"
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { isSnapshot, type Snapshot } from "../src/snapshot";
import { jitter, sequence } from "../src/sequence";

const dir = process.argv[2];
if (!dir) {
	console.log("Usage: npm run bench:jitter -- <graph-data folder>");
	process.exit(1);
}
const snaps: Snapshot[] = readdirSync(dir)
	.filter((f) => /^\d{4}-\d{2}-\d{2}(_\d{4})?\.json$/.test(f))
	.sort()
	.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown)
	.filter(isSnapshot);
console.log(`${snaps.length} snapshots in ${dir}\n`);

const rows = [];
for (const skipUnchanged of [false, true]) {
	for (const steady of [0, 0.5, 0.7, 0.85]) {
		const frames = sequence(snaps, { skipUnchanged, steady });
		rows.push({ skipUnchanged, steady, frames: frames.length, jitterPct: +jitter(frames).toFixed(2) });
	}
}
console.table(rows);
console.log("jitterPct: average distance a note moves between frames, as % of the frame's diagonal.");
