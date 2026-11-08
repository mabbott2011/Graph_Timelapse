import { App } from "obsidian";

export interface VaultStats {
	/** Markdown notes in the vault. */
	notes: number;
	/** Unique note-to-note connections (A↔B counted once). */
	links: number;
	/** Notes with no resolved link in or out. */
	orphans: number;
	/** Unique link targets that point at a note that doesn't exist. */
	unresolved: number;
}

export function collectStats(app: App): VaultStats {
	const files = app.vault.getMarkdownFiles();
	const resolved = app.metadataCache.resolvedLinks;
	const unresolvedLinks = app.metadataCache.unresolvedLinks;

	const edges = new Set<string>();
	const connected = new Set<string>();

	for (const [src, targets] of Object.entries(resolved)) {
		for (const dst of Object.keys(targets)) {
			if (dst === src || !dst.endsWith(".md")) continue;
			const key = src < dst ? `${src}\u0000${dst}` : `${dst}\u0000${src}`;
			edges.add(key);
			connected.add(src);
			connected.add(dst);
		}
	}

	const missing = new Set<string>();
	for (const targets of Object.values(unresolvedLinks)) {
		for (const name of Object.keys(targets)) missing.add(name);
	}

	return {
		notes: files.length,
		links: edges.size,
		orphans: files.filter((f) => !connected.has(f.path)).length,
		unresolved: missing.size,
	};
}

export function formatStats(s: VaultStats): string {
	const n = (v: number) => v.toLocaleString();
	return `${n(s.notes)} notes · ${n(s.links)} links · ${n(s.orphans)} orphans · ${n(s.unresolved)} unresolved`;
}
