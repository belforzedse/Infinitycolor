import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Every literal `/images/...` path in application source must exist under
 * `public/`. A missing file is silent in development and ships as a broken
 * image or a 404 on a real page — that is how the About page ended up
 * requesting `/images/placeholder-about.jpg`, which never existed, and how the
 * bale/eitaa/rubika social marks rendered as broken icons.
 *
 * Test files are excluded: their fixtures are deliberately synthetic paths.
 */
const APP_ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(APP_ROOT, "src");
const PUBLIC = path.join(APP_ROOT, "public");

function referencedImagePaths(): string[] {
  const out = execSync(
    `grep -rhoE '"/images/[^"]+\\.(jpg|jpeg|png|svg|webp|gif)"' ${JSON.stringify(SRC)} ` +
      `--include='*.ts' --include='*.tsx' ` +
      `--exclude-dir=__tests__ --exclude='*.test.ts' --exclude='*.test.tsx' ` +
      `--exclude='*.spec.ts' --exclude='*.spec.tsx' || true`,
    { encoding: "utf8" },
  );

  return Array.from(
    new Set(
      out
        .split("\n")
        .map((line) => line.trim().replace(/^"|"$/g, ""))
        .filter((line) => line.startsWith("/images/"))
        // A few call sites build comma-joined lists; check each member.
        .flatMap((line) => line.split(",").map((part) => part.trim()))
        .filter(Boolean),
    ),
  );
}

describe("public asset references", () => {
  it("finds image references to check", () => {
    expect(referencedImagePaths().length).toBeGreaterThan(20);
  });

  it("resolves every referenced image to a file in public/", () => {
    const missing = referencedImagePaths().filter(
      (ref) => !existsSync(path.join(PUBLIC, ref.replace(/^\//, ""))),
    );

    expect(missing).toEqual([]);
  });
});
