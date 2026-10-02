import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const required = ["catalog-transport.ts", "auth/callback/route.ts", "src/instrumentation.ts"];
const covered = new Set();
let matchingMaps = 0;
function visit(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) visit(path);
    else if (item.name.endsWith(".js.map")) {
      const map = JSON.parse(readFileSync(path, "utf8"));
      const source = path.slice(0, -4);
      if (!existsSync(source)) continue;
      const firstParty = required.filter((name) =>
        map.sources?.some((value) => value.replaceAll("\\", "/").includes(name)),
      );
      const debugId = map.debugId || map.debug_id;
      if (
        process.env.SENTRY_UPLOAD_ENABLED === "true" &&
        firstParty.length &&
        (!debugId || !readFileSync(source, "utf8").includes(debugId))
      )
        throw new Error(`Server source map Debug ID does not match ${item.name}`);
      matchingMaps += 1;
      for (const name of required)
        if (map.sources?.some((value) => value.replaceAll("\\", "/").includes(name)))
          covered.add(name);
    }
  }
}
visit(".next/server");
if (required.some((name) => !covered.has(name)))
  throw new Error(
    `Missing private server source maps: ${required.filter((name) => !covered.has(name)).join(", ")}`,
  );
console.log(
  `Verified ${matchingMaps} private server source maps and representative auth/catalog/instrumentation sources.`,
);
