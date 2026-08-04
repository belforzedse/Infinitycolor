import {
  adminApiUrl,
  adminRelease,
  validateAdminAnalyticsProvisioning,
  validateAdminRuntimeConfiguration,
} from "@/config/admin-env";
import { exactCentralAuthOrigin } from "@/lib/central-auth-origin";
import { adminLog } from "@/lib/admin-logger";

export const dynamic = "force-dynamic";

const TIMEOUT_MS = 2_000;

async function probe(name: "api" | "auth", url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      redirect: "manual",
    });
    return { name, ok: response.status < 500, status: response.status, durationMs: Date.now() - started };
  } catch {
    return { name, ok: false, reason: "unavailable" as const, durationMs: Date.now() - started };
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET() {
  try {
    validateAdminRuntimeConfiguration();
    validateAdminAnalyticsProvisioning();
    const dependencies = await Promise.all([
      probe("api", `${adminApiUrl()}/_health`),
      probe("auth", `${exactCentralAuthOrigin()}/api/health/live`),
    ]);
    const ok = dependencies.every((dependency) => dependency.ok);
    if (!ok) {
      adminLog("warn", "readiness_dependency_failed", {
        apiOk: dependencies[0]?.ok,
        authOk: dependencies[1]?.ok,
      });
    }
    return Response.json(
      { status: ok ? "ready" : "not_ready", service: "infinity-admin", release: adminRelease(), dependencies },
      { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch {
    adminLog("error", "readiness_configuration_failed");
    return Response.json(
      { status: "not_ready", service: "infinity-admin", release: adminRelease(), reason: "invalid_configuration" },
      { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
}
