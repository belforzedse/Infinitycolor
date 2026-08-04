import { adminLog } from "@/lib/admin-logger";

export const dynamic = "force-dynamic";

function safeBlockedOrigin(value: unknown): string {
  if (typeof value !== "string" || !value) return "unknown";
  if (["inline", "eval", "self", "data", "blob"].includes(value)) return value;
  try {
    return new URL(value).origin;
  } catch {
    return "malformed";
  }
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > 16_384) {
    return new Response(null, { status: 413, headers: { "Cache-Control": "no-store" } });
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > 16_384) {
    return new Response(null, { status: 413, headers: { "Cache-Control": "no-store" } });
  }
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    // Browsers may send an empty report while negotiating Reporting API support.
  }
  const report = (payload["csp-report"] || payload.body || payload) as Record<string, unknown>;
  adminLog("warn", "csp_violation", {
    directive: String(report["effective-directive"] || report.effectiveDirective || "unknown").slice(0, 80),
    blockedOrigin: safeBlockedOrigin(report["blocked-uri"] || report.blockedURL),
  });
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
