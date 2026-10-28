import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(__dirname, "../../../../..");

function serviceBlock(composePath: string, serviceName: string): string {
  const compose = readFileSync(resolve(repositoryRoot, composePath), "utf8");
  const match = compose.match(
    new RegExp(`^  ${serviceName}:\\n([\\s\\S]*?)(?=^  [a-zA-Z0-9_-]+:\\n|(?![\\s\\S]))`, "m"),
  );

  if (!match) {
    throw new Error(`Missing ${serviceName} service in ${composePath}`);
  }

  return match[1];
}

function anchorBlock(composePath: string, anchor: string): string {
  const compose = readFileSync(resolve(repositoryRoot, composePath), "utf8");
  const match = compose.match(new RegExp(`^x-${anchor}: &${anchor}\\n((?:  .*\\n)+)`, "m"));

  if (!match) {
    throw new Error(`Missing x-${anchor} anchor in ${composePath}`);
  }

  return match[1];
}

describe("background service deployment configuration", () => {
  it.each(["worker", "scheduler"])(
    "sets the exact production admin origin directly on %s",
    (serviceName) => {
      expect(serviceBlock("deploy/production/compose.yaml", serviceName)).toContain(
        "      ADMIN_URL: https://admin.infinitycolor.co",
      );
    },
  );

  // Staging runs its apps in blue/green slots from apps.compose.yml, where the
  // backend services share one environment through the x-backend-env anchor.
  it.each(["app-worker", "app-media-worker", "app-scheduler"])(
    "sets the exact staging admin origin on %s through the shared backend environment",
    (serviceName) => {
      const composePath = "deploy/infinity-staging/apps.compose.yml";
      const block = serviceBlock(composePath, serviceName);

      expect(block).toMatch(/^    environment:\n      <<: \*backend-env$/m);
      expect(block).not.toContain("ADMIN_URL:");
      expect(anchorBlock(composePath, "backend-env")).toContain(
        "  ADMIN_URL: https://admin.staging.infinitycolor.co\n",
      );
    },
  );
});
