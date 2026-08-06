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

describe("background service deployment configuration", () => {
  it.each(["worker", "scheduler"])(
    "sets the exact production admin origin directly on %s",
    (serviceName) => {
      expect(serviceBlock("deploy/production/compose.yaml", serviceName)).toContain(
        "      ADMIN_URL: https://admin.infinitycolor.co",
      );
    },
  );

  it.each(["backend-worker", "backend-scheduler"])(
    "sets the exact staging admin origin directly on %s",
    (serviceName) => {
      expect(serviceBlock("deploy/infinity-staging/docker-compose.yml", serviceName)).toContain(
        "      ADMIN_URL: https://admin.staging.infinitycolor.co",
      );
    },
  );
});
