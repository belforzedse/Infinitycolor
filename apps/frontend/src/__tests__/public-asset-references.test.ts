import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
  const references = new Set<string>();

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") {
          visit(fullPath);
        }
        continue;
      }

      if (
        !entry.isFile() ||
        !/\.tsx?$/.test(entry.name) ||
        /\.(test|spec)\.tsx?$/.test(entry.name)
      ) {
        continue;
      }

      const content = readFileSync(fullPath, "utf8");
      const pattern = /"(\/images\/[^"\r\n]+\.(?:jpg|jpeg|png|svg|webp|gif))"/g;

      for (const match of content.matchAll(pattern)) {
        for (const part of match[1].split(",")) {
          const reference = part.trim();

          if (reference) {
            references.add(reference);
          }
        }
      }
    }
  }

  visit(SRC);
  return Array.from(references);
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
