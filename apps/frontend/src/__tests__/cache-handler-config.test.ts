import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const frontendRoot = process.cwd();
const repositoryRoot = path.resolve(frontendRoot, "../..");

function read(relativePath: string): string {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function cachePrefix(environment: NodeJS.ProcessEnv): string {
  const handlerUrl = pathToFileURL(path.join(frontendRoot, "cache-handler.mjs")).href;
  const script = `import { getCacheKeyPrefix } from ${JSON.stringify(handlerUrl)}; process.stdout.write(getCacheKeyPrefix());`;
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      ...environment,
    },
  });
}

describe("shared storefront cache configuration", () => {
  it("uses the node-redis generation required by the Next 16 handler", () => {
    const packageJson = JSON.parse(read("apps/frontend/package.json"));
    expect(packageJson.dependencies.redis).toBe("5.8.3");
  });

  it("normalizes and isolates keys by environment, application, and release", () => {
    expect(
      cachePrefix({
        NEXT_CACHE_ENVIRONMENT: "Staging !!",
        NEXT_CACHE_RELEASE: "Release/ABC 123",
      }),
    ).toBe("infinity:staging:storefront:release-abc-123:incremental:v1:");
  });

  it("forces production replicas through the shared handler and keeps Cache Components disabled", () => {
    const nextConfig = read("apps/frontend/next.config.ts");
    expect(nextConfig).toContain("cacheMaxMemorySize: 0");
    expect(nextConfig).toContain('require.resolve("./cache-handler.mjs")');
    expect(nextConfig).not.toContain("cacheComponents: true");
  });

  it("embeds the exact build environment and revision in both runtime images", () => {
    for (const dockerfile of ["apps/frontend/dev.Dockerfile", "apps/frontend/main.Dockerfile"]) {
      const contents = read(dockerfile);
      expect(contents).toContain("NEXT_CACHE_ENVIRONMENT=${NEXT_PUBLIC_AUTH_ENVIRONMENT}");
      expect(contents).toContain("NEXT_CACHE_RELEASE=${GITHUB_SHA}");
    }
  });

  it("uses local LRU only during builds and fails runtime cache outages open to origin", () => {
    const handler = read("apps/frontend/cache-handler.mjs");
    expect(handler).toContain(
      "isBuild ? createLruOnlyConfig() : createOriginFallbackConfig()",
    );
    expect(handler).not.toContain("global.cacheHandlerConfig = createLruOnlyConfig()");
  });

  // Previously this asserted `reconnectStrategy: false`. That made a single
  // Redis blip permanently demote a replica to origin-only reads for the rest of
  // its process lifetime, and with 24 replicas demoting independently the fleet
  // stopped agreeing on cached content. The handler must now recover on its own.
  it("recovers from a transient cache outage instead of demoting the replica for good", () => {
    const handler = read("apps/frontend/cache-handler.mjs");
    expect(handler).not.toContain("reconnectStrategy: false");
    expect(handler).toContain("reconnectStrategy: (retries)");
    // Commands must still fail fast while the socket is down rather than queue.
    expect(handler).toContain("disableOfflineQueue: true");
  });
});
