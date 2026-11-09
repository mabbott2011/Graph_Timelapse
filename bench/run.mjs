// Bundles a bench script (Obsidian API stubbed, same as the tests) and runs it: node bench/run.mjs <name> [args]
import { build } from "esbuild";
import { spawnSync } from "child_process";

const [name, ...args] = process.argv.slice(2);
await build({
	entryPoints: [`bench/${name}.ts`],
	bundle: true,
	platform: "node",
	format: "esm",
	outfile: `bench/.out/${name}.mjs`,
	alias: { obsidian: "./test/stub-obsidian.ts" },
	logLevel: "error",
});
const run = spawnSync(process.execPath, ["--max-old-space-size=4096", `bench/.out/${name}.mjs`, ...args], { stdio: "inherit" });
process.exit(run.status ?? 1);
