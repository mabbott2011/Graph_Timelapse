import { Frame, FrameNode, frameOf } from "./render";
import { Pt, Snapshot, procrustes, signature } from "./snapshot";

/**
 * Turns a run of snapshots into the frames a timelapse plays, without
 * changing the recorded data:
 *
 * - Skip unchanged: snapshots whose notes and links are identical to the one
 *   before only differ in layout, so they are folded into it (keeping the
 *   later date and counts). Without this, a quiet afternoon of half-hourly
 *   snapshots plays as nothing but layout noise.
 * - Steady layout: Obsidian lays the graph out from scratch on every capture,
 *   so notes swap places even when nothing changed. Each note that already
 *   had a place moves only part of the way towards its new one; new notes
 *   appear next to the notes they link to. Growth reads as growth.
 */

export interface SequenceOptions {
	skipUnchanged: boolean;
	/** 0 = play Obsidian's layouts as recorded; up to 0.95 = notes barely move. */
	steady: number;
}

export const DEFAULT_STEADY = 0.7;

/** Auto speed aims for a timelapse about this long… */
export const AUTO_SECONDS = 15;
/** …but never slower or faster than this many snapshots per second. */
export const AUTO_MIN_SPEED = 1;
export const AUTO_MAX_SPEED = 8;

/**
 * Snapshots per second for a timelapse of `frames` frames: short histories
 * play slowly enough to follow, long ones speed up so the video stays watchable.
 */
export function autoSpeed(frames: number): number {
	const s = Math.max(frames - 1, 0) / AUTO_SECONDS;
	return Math.min(Math.max(Math.round(s * 2) / 2, AUTO_MIN_SPEED), AUTO_MAX_SPEED);
}
export const DEFAULT_SEQUENCE: SequenceOptions = { skipUnchanged: true, steady: DEFAULT_STEADY };

function boundsOf(nodes: Map<string, FrameNode>): Frame["bounds"] {
	const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
	for (const n of nodes.values()) {
		b.minX = Math.min(b.minX, n.x - n.r);
		b.minY = Math.min(b.minY, n.y - n.r);
		b.maxX = Math.max(b.maxX, n.x + n.r);
		b.maxY = Math.max(b.maxY, n.y + n.r);
	}
	return isFinite(b.minX) ? b : { minX: -1, minY: -1, maxX: 1, maxY: 1 };
}

/** `cur` laid out to stay close to `prev` (see the module comment). */
export function steadyFrame(prev: Frame | null, cur: Frame, amount: number): Frame {
	if (!prev || amount <= 0) return cur;
	const pairs: { a: Pt; b: Pt }[] = [];
	for (const [id, n] of cur.nodes) {
		const p = prev.nodes.get(id);
		if (p) pairs.push({ a: p, b: n });
	}
	const fit = procrustes(pairs);
	if (!fit) return cur;
	const follow = 1 - Math.min(amount, 0.95);

	const fitted = new Map<string, Pt>();
	for (const [id, n] of cur.nodes) fitted.set(id, fit(n));

	const nodes = new Map<string, FrameNode>();
	for (const [id, n] of cur.nodes) {
		const p = prev.nodes.get(id);
		if (!p) continue;
		const f = fitted.get(id)!;
		nodes.set(id, { ...n, x: p.x + (f.x - p.x) * follow, y: p.y + (f.y - p.y) * follow });
	}

	// New notes keep their offset from the notes they link to, so they appear beside them.
	const anchors = new Map<string, string[]>();
	const add = (id: string, to: string) => {
		const l = anchors.get(id);
		if (l) l.push(to);
		else anchors.set(id, [to]);
	};
	for (const l of cur.links) {
		const aOld = nodes.has(l.a);
		const bOld = nodes.has(l.b);
		if (!aOld && bOld) add(l.a, l.b);
		if (!bOld && aOld) add(l.b, l.a);
	}
	for (const [id, n] of cur.nodes) {
		if (nodes.has(id)) continue;
		const f = fitted.get(id)!;
		const near = anchors.get(id);
		if (!near?.length) {
			nodes.set(id, { ...n, x: f.x, y: f.y });
			continue;
		}
		let sx = 0;
		let sy = 0;
		let fx = 0;
		let fy = 0;
		for (const m of near) {
			const q = nodes.get(m)!;
			const g = fitted.get(m)!;
			sx += q.x;
			sy += q.y;
			fx += g.x;
			fy += g.y;
		}
		const k = near.length;
		nodes.set(id, { ...n, x: sx / k + (f.x - fx / k), y: sy / k + (f.y - fy / k) });
	}

	return {
		nodes,
		links: cur.links,
		line: cur.line,
		bounds: boundsOf(nodes),
		label: cur.label,
		order: [...nodes.values()].sort((p, q) => p.r - q.r),
	};
}

/** Feed snapshots in date order; frames come out as soon as they're final. */
export class Sequencer {
	private pending: Snapshot | null = null;
	private pendingSig = "";
	private prev: Frame | null = null;
	/** Snapshots folded into an earlier one because nothing changed. */
	skipped = 0;

	constructor(private o: SequenceOptions = DEFAULT_SEQUENCE) {}

	push(s: Snapshot): Frame[] {
		const sig = this.o.skipUnchanged ? signature(s) : "";
		if (this.pending && this.o.skipUnchanged && sig === this.pendingSig) {
			// Same graph: keep the earlier layout, show the later date and counts.
			this.pending = { ...this.pending, key: s.key, takenAt: s.takenAt, stats: s.stats };
			this.skipped++;
			return [];
		}
		const out = this.pending ? [this.emit(this.pending)] : [];
		this.pending = s;
		this.pendingSig = sig;
		return out;
	}

	flush(): Frame[] {
		const out = this.pending ? [this.emit(this.pending)] : [];
		this.pending = null;
		return out;
	}

	private emit(s: Snapshot): Frame {
		const f = steadyFrame(this.prev, frameOf(s), this.o.steady);
		this.prev = f;
		return f;
	}
}

export function sequence(snaps: Snapshot[], o: SequenceOptions = DEFAULT_SEQUENCE): Frame[] {
	const q = new Sequencer(o);
	const out: Frame[] = [];
	for (const s of snaps) out.push(...q.push(s));
	out.push(...q.flush());
	return out;
}

/** Mean distance shared notes move from A to B, as % of B's diagonal (null if none are shared). */
export function frameShift(A: Frame, B: Frame): number | null {
	const diag = Math.hypot(B.bounds.maxX - B.bounds.minX, B.bounds.maxY - B.bounds.minY) || 1;
	let d = 0;
	let c = 0;
	for (const [id, b] of B.nodes) {
		const a = A.nodes.get(id);
		if (!a) continue;
		d += Math.hypot(a.x - b.x, a.y - b.y);
		c++;
	}
	return c ? (d / c / diag) * 100 : null;
}

/** Average frameShift over a run of frames: how much the timelapse jumps around. */
export function jitter(frames: Frame[]): number {
	let sum = 0;
	let count = 0;
	for (let i = 1; i < frames.length; i++) {
		const v = frameShift(frames[i - 1], frames[i]);
		if (v !== null) {
			sum += v;
			count++;
		}
	}
	return count ? sum / count : 0;
}
