import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality, WebMOutputFormat, canEncodeVideo } from "mediabunny";
import { CREDIT, DrawOptions, Frame, Transition, drawFrame } from "./render";

/**
 * Video export: replays the same transitions as the embed on an offscreen
 * canvas and encodes them.
 *
 * Main path: WebCodecs (via Mediabunny's muxer). Every frame gets an exact
 * timestamp, so the video is smooth however long a big graph takes to draw,
 * and it renders as fast as the machine can go. Fallback, for devices without
 * WebCodecs: MediaRecorder, paced in real time.
 *
 * Kept free of the Obsidian API so the planning logic can be tested in Node.
 */

export type VideoFormat = "mp4" | "webm";
type Codec = "avc" | "vp9" | "vp8";

export type Engine =
	| { kind: "webcodecs"; ext: VideoFormat; codec: Codec; fellBack: boolean }
	| { kind: "recorder"; ext: VideoFormat; mime: string; fellBack: boolean };

const CODECS: Record<VideoFormat, Codec[]> = { mp4: ["avc"], webm: ["vp9", "vp8"] };
const MIME: Record<VideoFormat, string[]> = {
	mp4: ["video/mp4;codecs=avc1.640028", "video/mp4;codecs=avc1.42E01E", "video/mp4;codecs=avc1", "video/mp4"],
	webm: ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"],
};

export interface PickedMime {
	mime: string;
	ext: VideoFormat;
	/** True when the asked-for format isn't supported here and the other one was used. */
	fellBack: boolean;
}

const order = (want: VideoFormat): [VideoFormat, boolean][] => [
	[want, false],
	[want === "mp4" ? "webm" : "mp4", true],
];

/** Best MediaRecorder container/codec, preferring the asked-for format. */
export function pickMime(want: VideoFormat, supported: (m: string) => boolean): PickedMime | null {
	for (const [fmt, fellBack] of order(want)) {
		const m = MIME[fmt].find((x) => supported(x));
		if (m) return { mime: m, ext: fmt, fellBack };
	}
	return null;
}

export interface EngineProbe {
	canEncode: (codec: Codec, width: number, height: number) => Promise<boolean>;
	recorderSupports: ((mime: string) => boolean) | null;
}

/** The real browser capabilities. */
export function browserProbe(): EngineProbe {
	const webcodecs = typeof VideoEncoder !== "undefined";
	const recorder = typeof MediaRecorder !== "undefined" && typeof HTMLCanvasElement.prototype.captureStream === "function";
	return {
		canEncode: async (codec, width, height) => webcodecs && (await canEncodeVideo(codec, { width, height }).catch(() => false)),
		recorderSupports: recorder ? (m) => MediaRecorder.isTypeSupported(m) : null,
	};
}

/** WebCodecs in the asked-for format, then the other format, then MediaRecorder. */
export async function chooseEngine(want: VideoFormat, width: number, height: number, probe: EngineProbe): Promise<Engine | null> {
	for (const [fmt, fellBack] of order(want)) {
		for (const codec of CODECS[fmt]) {
			if (await probe.canEncode(codec, width, height)) return { kind: "webcodecs", ext: fmt, codec, fellBack };
		}
	}
	if (probe.recorderSupports) {
		const m = pickMime(want, probe.recorderSupports);
		if (m) return { kind: "recorder", ...m };
	}
	return null;
}

export interface VideoPlan {
	/** Frames spent on each snapshot-to-snapshot transition. */
	stepFrames: number;
	/** Frames the last snapshot is held for. */
	holdFrames: number;
	totalFrames: number;
	seconds: number;
}

/** How many frames a video of `snapshots` snapshots takes. */
export function planVideo(snapshots: number, fps: number, speed: number, holdSeconds: number): VideoPlan {
	const stepFrames = Math.max(1, Math.round(fps / Math.max(speed, 0.01)));
	const holdFrames = Math.max(1, Math.round(Math.max(holdSeconds, 0) * fps));
	const totalFrames = Math.max(snapshots - 1, 0) * stepFrames + holdFrames;
	return { stepFrames, holdFrames, totalFrames, seconds: totalFrames / fps };
}

export interface RecordOptions {
	/** Snapshot frames in order, streamed one ahead of playback. */
	frames: AsyncIterable<Frame>;
	/** How many frames to expect (an upper bound), for progress and planning. */
	count: number;
	draw: DrawOptions;
	fps: number;
	speed: number;
	holdSeconds: number;
	engine: Engine;
	onProgress?: (done: number, total: number) => void;
	isCancelled?: () => boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/** Walks the snapshots and hands each video frame to `emit`, in order. */
async function play(o: RecordOptions, emit: (f: Frame) => Promise<void>) {
	const plan = planVideo(o.count, o.fps, o.speed, o.holdSeconds);
	const it = o.frames[Symbol.asyncIterator]();
	const first = await it.next();
	if (first.done) throw new Error("No snapshots to play");
	let a = first.value;
	let next = it.next(); // load the next snapshot while this transition renders
	let steps = 0;
	for (;;) {
		if (o.isCancelled?.()) throw new Error("Cancelled");
		const r = await next;
		if (r.done) break;
		next = it.next();
		const tr = new Transition(a, r.value);
		for (let k = 0; k < plan.stepFrames; k++) await emit(tr.at(k / plan.stepFrames));
		a = r.value;
		steps++;
	}
	if (steps === 0) throw new Error("Nothing changed in this range, so there's nothing to animate");
	for (let k = 0; k < plan.holdFrames; k++) await emit(a);
}

/** Render and encode the timelapse. Resolves with the finished file. */
export async function recordVideo(o: RecordOptions): Promise<Blob> {
	if (o.count < 2) throw new Error("Need at least two snapshots");
	const plan = planVideo(o.count, o.fps, o.speed, o.holdSeconds);
	const canvas = createEl("canvas");
	// Even sizes keep H.264 encoders happy.
	canvas.width = o.draw.width - (o.draw.width % 2);
	canvas.height = o.draw.height - (o.draw.height % 2);
	const draw: DrawOptions = { ...o.draw, width: canvas.width, height: canvas.height, credit: CREDIT }; // always credited
	const ctx = canvas.getContext("2d", { alpha: false });
	if (!ctx) throw new Error("No 2D canvas");

	let done = 0;
	const tick = async () => {
		done++;
		if (done % 10 === 0) {
			o.onProgress?.(done, plan.totalFrames);
			if (o.isCancelled?.()) throw new Error("Cancelled");
		}
	};

	const blob = o.engine.kind === "webcodecs" ? await viaWebCodecs(o, o.engine, canvas, ctx, draw, tick) : await viaRecorder(o, o.engine.mime, canvas, ctx, draw, tick);
	o.onProgress?.(plan.totalFrames, plan.totalFrames);
	return blob;
}

async function viaWebCodecs(
	o: RecordOptions,
	e: Extract<Engine, { kind: "webcodecs" }>,
	canvas: HTMLCanvasElement,
	ctx: CanvasRenderingContext2D,
	draw: DrawOptions,
	tick: () => Promise<void>,
): Promise<Blob> {
	const target = new BufferTarget();
	const output = new Output({
		format: e.ext === "mp4" ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat(),
		target,
	});
	const source = new CanvasSource(canvas, { codec: e.codec, quality: new Quality("high"), keyFrameInterval: 2 });
	output.addVideoTrack(source, { frameRate: o.fps });
	await output.start();
	let n = 0;
	try {
		await play(o, async (f) => {
			drawFrame(ctx, f, draw);
			await source.add(n / o.fps, 1 / o.fps);
			n++;
			if (n % 10 === 0) await sleep(0); // let the progress notice repaint
			await tick();
		});
		await output.finalize();
	} catch (err) {
		await output.cancel().catch(() => undefined);
		throw err;
	}
	const buf = target.buffer;
	if (!buf) throw new Error("Encoder produced no data");
	return new Blob([buf], { type: e.ext === "mp4" ? "video/mp4" : "video/webm" });
}

/** Fallback: MediaRecorder timestamps frames by wall-clock time, so frames are paced in real time. */
async function viaRecorder(
	o: RecordOptions,
	mime: string,
	canvas: HTMLCanvasElement,
	ctx: CanvasRenderingContext2D,
	draw: DrawOptions,
	tick: () => Promise<void>,
): Promise<Blob> {
	const stream = canvas.captureStream(0);
	const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
	const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.round(canvas.width * canvas.height * o.fps * 0.15) });
	const chunks: Blob[] = [];
	recorder.ondataavailable = (ev) => {
		if (ev.data.size) chunks.push(ev.data);
	};
	const stopped = new Promise<void>((resolve, reject) => {
		recorder.onstop = () => resolve();
		recorder.onerror = () => reject(new Error("Recorder error"));
	});
	const frameMs = 1000 / o.fps;
	let next = 0;
	try {
		recorder.start(1000);
		next = performance.now();
		await play(o, async (f) => {
			drawFrame(ctx, f, draw);
			track.requestFrame?.();
			next += frameMs;
			const wait = next - performance.now();
			if (wait > 0) await sleep(wait);
			else next = performance.now();
			await tick();
		});
		recorder.stop();
		await stopped;
	} catch (err) {
		if (recorder.state !== "inactive") recorder.stop();
		throw err;
	} finally {
		track.stop();
	}
	return new Blob(chunks, { type: mime.split(";")[0] });
}
