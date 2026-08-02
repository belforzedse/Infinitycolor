import type { PlaywrightTestConfig } from "@playwright/test";

type WebServerConfig = NonNullable<PlaywrightTestConfig["webServer"]>;
type WebServerEntry = WebServerConfig extends infer Config
  ? Config extends readonly (infer Entry)[]
    ? Entry
    : Config
  : never;

export function extendWebServers(
  webServer: PlaywrightTestConfig["webServer"],
  options: {
    timeout: number;
    env: Record<string, string>;
  },
): PlaywrightTestConfig["webServer"] {
  if (!webServer) return undefined;
  const servers: WebServerEntry[] = Array.isArray(webServer)
    ? webServer
    : [webServer];

  return servers.map((server) => ({
    ...server,
    timeout: options.timeout,
    env: {
      ...server.env,
      ...options.env,
    },
  }));
}
