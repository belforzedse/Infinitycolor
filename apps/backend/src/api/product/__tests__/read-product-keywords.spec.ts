import type { Strapi } from "@strapi/strapi";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readProductKeywords } from "../services/product-title-keywords";

describe("readProductKeywords", () => {
  let temporaryRoot: string;
  let filePath: string;
  let strapi: Strapi;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "infinity-read-keywords-"));

    const directory = path.join(temporaryRoot, ".tmp");
    await mkdir(directory);

    filePath = path.join(directory, "product-title-keywords.json");

    strapi = {
      dirs: { app: { root: temporaryRoot } },
    } as unknown as Strapi;
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("reads keywords from the JSON file", async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        generatedAt: "2026-10-26T00:00:00.000Z",
        keywords: ["شومیز", "نخی"],
      }),
      "utf8",
    );

    await expect(readProductKeywords(strapi)).resolves.toEqual(["شومیز", "نخی"]);
  });

  it("returns an empty array when the file does not exist", async () => {
    await expect(readProductKeywords(strapi)).resolves.toEqual([]);
  });

  it("rejects keywords that contain a non-string value", async () => {
    await writeFile(filePath, JSON.stringify({ keywords: ["شومیز", 123] }), "utf8");

    await expect(readProductKeywords(strapi)).rejects.toThrow("Invalid product keywords file");
  });
});
