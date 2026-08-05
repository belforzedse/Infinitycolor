import fs from "node:fs";
import path from "node:path";

describe("admin service worker privacy policy", () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), "src/app/sw.js/route.ts"), "utf8");

  it("uses an admin-only cache and waits for explicit update acceptance", () => {
    expect(source).toContain("infinity-admin-static-");
    expect(source).toContain('event.data?.type === "SKIP_WAITING"');
    expect(source).not.toMatch(/addEventListener\("install"[\s\S]{0,500}skipWaiting/);
  });

  it("keeps protected traffic network-only", () => {
    for (const marker of ["/api/", "/auth/", "/uploads/", "/export", "/download", "/print"]) {
      expect(source).toContain(marker);
    }
    expect(source).toContain('request.method !== "GET"');
    expect(source).toContain("caches.match(OFFLINE_URL)");
  });
});
