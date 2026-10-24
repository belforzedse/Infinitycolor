// Compile test sources without installing a runtime loader over Strapi's CommonJS dependencies.
import { build } from "esbuild";
import { spawn } from "node:child_process";
await build({ entryPoints: ["scripts/mellat-lab.ts"], outfile: "test-results/mellat-lab.runtime.mjs", platform: "node", format: "esm" });
await build({ entryPoints: ["../backend/src/__tests__/integration/factories/index.ts"], outfile: "test-results/mellat-factories.cjs", platform: "node", format: "cjs" });
const child = spawn(process.execPath, ["test-results/mellat-lab.runtime.mjs"], { stdio: "inherit", env: process.env });
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
child.on("exit", (code) => process.exit(code || 0));
