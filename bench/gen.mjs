// Kept for `npm run bench:gen`; see run.mjs.
import { spawnSync } from "child_process";
const run = spawnSync(process.execPath, ["bench/run.mjs", "generate", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(run.status ?? 1);
