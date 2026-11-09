// Bundles each test with esbuild (Obsidian's API stubbed out) and runs it with Node's built-in test runner.
import { build } from "esbuild";
import { readdirSync, rmSync } from "fs";
import { spawnSync } from "child_process";

const files = readdirSync("test").filter((f) => f.endsWith(".test.ts"));
rmSync("test/.out", { recursive: true, force: true });
await build({
	entryPoints: files.map((f) => `test/${f}`),
	bundle: true,
	platform: "node",
	format: "esm",
	outdir: "test/.out",
	outExtension: { ".js": ".mjs" },
	alias: { obsidian: "./test/stub-obsidian.ts" },
	logLevel: "error",
});
const run = spawnSync(process.execPath, ["--test", ...files.map((f) => `test/.out/${f.replace(/\.ts$/, ".mjs")}`)], { stdio: "inherit" });
process.exit(run.status ?? 1);
