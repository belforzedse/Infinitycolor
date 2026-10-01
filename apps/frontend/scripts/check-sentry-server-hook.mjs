import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// A unit import can pass even when Next omits the hook from its deployed server.
const hook = ".next/server/instrumentation.js";
const manifest = JSON.parse(readFileSync(resolve(".next/required-server-files.json"), "utf8"));
if (!existsSync(resolve(hook)) || !manifest.files?.includes(hook)) {
  throw new Error("The built server is missing its Sentry instrumentation hook.");
}
console.log("Built server includes the Sentry instrumentation hook.");
