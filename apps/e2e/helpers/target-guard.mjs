/**
 * The staging suite creates shoppers, carts and orders. This is the check that
 * keeps it off production: every origin a run talks to must be staging, a
 * loopback/`.test` host for local stacks, or a host named explicitly in
 * E2E_ALLOW_TARGET_HOSTS. Production hosts are refused even if listed there.
 */

const PRODUCTION_HOSTS = new Set([
  "infinitycolor.co",
  "www.infinitycolor.co",
  "new.infinitycolor.co",
  "api.infinitycolor.co",
  "auth.infinitycolor.co",
  "admin.infinitycolor.co",
  "cdn.infinitycolor.co",
  "infinitygram.co",
  "www.infinitygram.co",
]);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** @param {string} host */
function isStaging(host) {
  return host === "staging.infinitycolor.co" || host.endsWith(".staging.infinitycolor.co");
}

/**
 * @param {Record<string, string>} origins name -> URL
 * @param {{ allowHosts?: string }} [options]
 * @returns {{ ok: true } | { ok: false; problems: string[] }}
 */
export function checkTargets(origins, options = {}) {
  const allowed = new Set(
    String(options.allowHosts || "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
  const problems = [];
  for (const [name, value] of Object.entries(origins)) {
    let host;
    try {
      host = new URL(value).hostname.toLowerCase();
    } catch {
      problems.push(`${name}=${value} is not a URL`);
      continue;
    }
    if (PRODUCTION_HOSTS.has(host)) {
      problems.push(`${name} points at production (${host}); the staging suite never runs there`);
    } else if (!isStaging(host) && !LOOPBACK_HOSTS.has(host) && !host.endsWith(".test") && !allowed.has(host)) {
      problems.push(`${name} host ${host} is not staging; add it to E2E_ALLOW_TARGET_HOSTS if it is a disposable stack`);
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true };
}

/**
 * @param {Record<string, string>} origins
 * @param {{ allowHosts?: string }} [options]
 */
export function assertSafeTargets(origins, options = {}) {
  const result = checkTargets(origins, options);
  if (!result.ok) {
    throw new Error(`Refusing to run the staging E2E suite:\n- ${result.problems.join("\n- ")}`);
  }
}
