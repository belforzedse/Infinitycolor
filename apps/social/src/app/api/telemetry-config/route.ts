import { connection, NextResponse } from "next/server";

/**
 * Runtime analytics config for the social app's video playback telemetry.
 *
 * Read per request (`connection()`), not at build: the Umami host and website id are
 * deployment values set on the social containers (UMAMI_URL, UMAMI_WEBSITE_ID), so
 * turning telemetry on or off never needs a rebuild. Unset or malformed → disabled.
 */
const WEBSITE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeBaseUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && process.env.NODE_ENV === "production") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export async function GET() {
  await connection();
  const umamiUrl = normalizeBaseUrl(process.env.UMAMI_URL);
  const websiteId = (process.env.UMAMI_WEBSITE_ID ?? "").trim();
  const enabled = Boolean(umamiUrl && WEBSITE_ID.test(websiteId));
  return NextResponse.json(enabled ? { umamiUrl, websiteId } : { umamiUrl: null, websiteId: null }, {
    headers: { "Cache-Control": "public, max-age=300, s-maxage=300" },
  });
}
