import type { Strapi } from "@strapi/strapi";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export async function fetchProductTitles(strapi: Strapi): Promise<string[]> {
  const titles: string[] = [];
  const batchSize = 500;
  let lastId = 0;

  while (true) {
    const products = await strapi.db.query("api::product.product").findMany({
      select: ["id", "Title"],
      where: {
        id: { $gt: lastId },
        removedAt: { $null: true },
        purgedAt: { $null: true },
      },
      orderBy: { id: "asc" },
      limit: batchSize,
    });

    if (products.length === 0) break;

    for (const product of products) {
      if (typeof product.Title !== "string") continue;

      const title = product.Title.trim();

      if (title) titles.push(title);
    }

    lastId = products[products.length - 1].id;

    if (products.length < batchSize) break;
  }

  return titles;
}
export function extractProductKeywords(titles: string[]): string[] {
  const keywords = new Set<string>();
  const ignoredWords = new Set(["و", "از", "به", "با", "در", "برای", "یک"]);

  for (const title of titles) {
    const normalizedTitle = title
      .normalize("NFKC")
      .replace(/[يى]/g, "ی")
      .replace(/ك/g, "ک")
      .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
      .toLowerCase();

    const words = normalizedTitle.match(/\p{L}+(?:\u200c\p{L}+)*/gu) ?? [];

    for (const word of words) {
      if (word.length < 2 || ignoredWords.has(word)) continue;

      keywords.add(word);
    }
  }

  return Array.from(keywords);
}
export async function rebuildProductKeywords(strapi: Strapi): Promise<string> {
  const titles = await fetchProductTitles(strapi);
  const keywords = extractProductKeywords(titles);

  const directory = path.join(strapi.dirs.app.root, ".tmp");
  const filePath = path.join(directory, "product-title-keywords.json");
  const temporaryPath = path.join(directory, `product-title-keywords-${randomUUID()}.tmp`);

  const data = {
    version: 1,
    generatedAt: new Date().toISOString(),
    keywords,
  };

  await mkdir(directory, { recursive: true });

  try {
    await writeFile(temporaryPath, JSON.stringify(data, null, 2), "utf8");

    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }

  return filePath;
}
export async function readProductKeywords(strapi: Strapi): Promise<string[]> {
  const filePath = path.join(strapi.dirs.app.root, ".tmp", "product-title-keywords.json");

  let content: string;

  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const data: unknown = JSON.parse(content);

  if (
    typeof data !== "object" ||
    data === null ||
    !("keywords" in data) ||
    !Array.isArray(data.keywords) ||
    !data.keywords.every((word) => typeof word === "string")
  ) {
    throw new Error("Invalid product keywords file");
  }

  return data.keywords;
}
