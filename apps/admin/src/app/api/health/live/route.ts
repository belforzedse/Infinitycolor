import { adminRelease } from "@/config/admin-env";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { status: "ok", service: "infinity-admin", release: adminRelease() },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
