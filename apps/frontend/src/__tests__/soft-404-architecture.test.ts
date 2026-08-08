/**
 * Architecture guard: soft-404 prevention.
 *
 * Next.js documents that streamed responses lock the HTTP status at 200. Any
 * root-level `loading.tsx` or a Suspense boundary around `{children}` in the
 * root layout causes every `notFound()` call in the tree to render the
 * not-found UI under HTTP 200 — a soft-404 that crawlers may still treat as a
 * real page unless noindex is present, and that analytics/compliance cannot
 * count as a 404.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/loading#status-codes
 * @see https://github.com/vercel/next.js/issues/93253
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const frontendRoot = process.cwd();

function read(relativePath: string): string {
  return readFileSync(path.join(frontendRoot, relativePath), "utf8");
}

describe("soft-404 prevention architecture", () => {
  it("does not ship a root loading.tsx that would stream every route as 200", () => {
    expect(existsSync(path.join(frontendRoot, "src/app/loading.tsx"))).toBe(false);
  });

  it("does not wrap the root page tree in Suspense", () => {
    const layout = read("src/app/layout.tsx");
    expect(layout).toContain('<div id="main-content">{children}</div>');
    expect(layout).not.toMatch(
      /<Suspense[^>]*>\s*<div id="main-content">\{children\}<\/div>\s*<\/Suspense>/,
    );
  });

  it("does not place a loading.tsx beside the PDP page (existence check must run first)", () => {
    expect(
      existsSync(path.join(frontendRoot, "src/app/(product)/pdp/[slug]/loading.tsx")),
    ).toBe(false);
  });

  it("keeps a PDP-scoped not-found boundary for missing products", () => {
    expect(
      existsSync(path.join(frontendRoot, "src/app/(product)/pdp/[slug]/not-found.tsx")),
    ).toBe(true);
  });
});
