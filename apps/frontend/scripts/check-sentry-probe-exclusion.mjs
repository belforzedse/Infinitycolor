import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

if (process.env.NEXT_PUBLIC_AUTH_ENVIRONMENT !== "staging") {
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (
        entry.name.endsWith(".js") &&
        /StagingSourceMapProbeError|Infinitycolor staging source-map verification/.test(
          readFileSync(file, "utf8"),
        )
      ) {
        throw new Error("Production browser assets contain the staging Sentry probe");
      }
    }
  };
  visit(".next/static");
  console.info("Production browser assets exclude the staging Sentry probe.");
}
