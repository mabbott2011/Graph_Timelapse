import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseEngine, pickMime, planVideo } from "../src/video";
import { keysInRange } from "../src/export";

test("prefers the asked-for format", () => {
	const all = () => true;
	assert.deepEqual(pickMime("mp4", all)?.ext, "mp4");
	assert.deepEqual(pickMime("webm", all)?.ext, "webm");
	assert.equal(pickMime("mp4", all)?.fellBack, false);
});

test("falls back to the other format when one isn't supported", () => {
	const webmOnly = (m: string) => m.startsWith("video/webm");
	const p = pickMime("mp4", webmOnly);
	assert.equal(p?.ext, "webm");
	assert.equal(p?.fellBack, true);
	assert.equal(pickMime("mp4", () => false), null);
});

test("video length follows snapshots, speed and hold", () => {
	const p = planVideo(31, 30, 4, 2); // 30 transitions at 4/s = 7.5 s, plus 2 s hold
	assert.equal(p.stepFrames, 8);
	assert.equal(p.holdFrames, 60);
	assert.equal(p.totalFrames, 30 * 8 + 60);
	assert.ok(Math.abs(p.seconds - 10) < 0.01);
	assert.equal(planVideo(2, 30, 60, 0).stepFrames, 1); // never zero frames per step
});

test("date range is inclusive by day", () => {
	const keys = ["2026-11-01", "2026-11-02_0930", "2026-11-03", "2026-11-04"];
	assert.deepEqual(keysInRange(keys, "2026-11-02", "2026-11-03"), ["2026-11-02_0930", "2026-11-03"]);
});

test("prefers WebCodecs, falls back across formats, then to MediaRecorder", async () => {
	const yes = async () => true;
	assert.deepEqual(await chooseEngine("mp4", 1080, 1080, { canEncode: yes, recorderSupports: null }), { kind: "webcodecs", ext: "mp4", codec: "avc", fellBack: false });
	const vp8Only = { canEncode: async (c: string) => c === "vp8", recorderSupports: null };
	assert.deepEqual(await chooseEngine("mp4", 1080, 1080, vp8Only), { kind: "webcodecs", ext: "webm", codec: "vp8", fellBack: true });
	const recorderOnly = { canEncode: async () => false, recorderSupports: (m: string) => m.startsWith("video/mp4") };
	assert.equal((await chooseEngine("mp4", 1080, 1080, recorderOnly))?.kind, "recorder");
	assert.equal(await chooseEngine("mp4", 1080, 1080, { canEncode: async () => false, recorderSupports: null }), null);
});
