/**
 * Types for the parts of Obsidian's graph view this plugin reads.
 *
 * None of this is public API. Every field is optional and every use is
 * guarded, so an Obsidian update that changes these makes the plugin fall
 * back instead of crashing.
 */

export interface PixiColor {
	a?: number;
	rgb?: number;
}

export interface GraphNodeInternal {
	id?: unknown;
	type?: unknown;
	x?: unknown;
	y?: unknown;
	weight?: unknown;
	color?: PixiColor | null;
	getSize?: () => unknown;
	getFillColor?: () => PixiColor | null | undefined;
}

export interface GraphLinkInternal {
	source?: GraphNodeInternal;
	target?: GraphNodeInternal;
}

export interface PixiRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface PixiPoint {
	x: number;
	y: number;
	set?: (x: number, y: number) => void;
}

export interface PixiContainer {
	position?: PixiPoint;
	scale?: PixiPoint;
	pivot?: PixiPoint;
	rotation?: number;
	getLocalBounds?: () => PixiRect;
}

export interface PixiTexture {
	destroy?: (destroyBase?: boolean) => void;
}

export interface PixiExtract {
	canvas?: (target: unknown) => unknown;
}

export interface PixiRenderer {
	extract?: PixiExtract;
	plugins?: { extract?: PixiExtract };
	generateTexture?: (...args: unknown[]) => PixiTexture | null | undefined;
}

export interface GraphRendererInternal {
	px?: { renderer?: PixiRenderer; stage?: PixiContainer };
	nodes?: GraphNodeInternal[];
	links?: GraphLinkInternal[];
	colors?: Record<string, PixiColor | undefined>;
	fNodeSizeMult?: unknown;
	fLineSizeMult?: unknown;
}

export interface GraphViewInternal {
	renderer?: GraphRendererInternal;
	containerEl?: HTMLElement;
}

export const num = (v: unknown, fallback = 0): number => {
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) ? n : fallback;
};

export function isCanvas(v: unknown): v is HTMLCanvasElement {
	return (
		typeof v === "object" &&
		v !== null &&
		typeof (v as HTMLCanvasElement).getContext === "function" &&
		(v as HTMLCanvasElement).width > 0 &&
		(v as HTMLCanvasElement).height > 0
	);
}
