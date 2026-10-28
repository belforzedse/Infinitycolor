import type { Strapi } from "@strapi/strapi";

const pendingReads = new WeakMap<Strapi, Promise<string[]>>();

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

export function readProductKeywords(strapi: Strapi): Promise<string[]> {
  const pending = pendingReads.get(strapi);
  if (pending) return pending;

  // Only share work while a query is running. The next request reads current
  // titles, including writes from other replicas and lifecycle commands.
  const reading = fetchProductTitles(strapi)
    .then(extractProductKeywords)
    .finally(() => {
      pendingReads.delete(strapi);
    });

  pendingReads.set(strapi, reading);
  return reading;
}
