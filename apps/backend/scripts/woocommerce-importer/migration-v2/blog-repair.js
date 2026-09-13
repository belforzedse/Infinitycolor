"use strict";

/**
 * Re-import blog bodies so their embedded blocks reach Infinity.
 *
 * WordPress articles carry a product carousel and the shop's promotional
 * section as theme shortcodes. The importer stored WordPress's `context=edit`
 * rendering, in which the carousel never expands at all and the promotional
 * section arrives as theme markup with no theme CSS behind it — so 116 articles
 * lost their products and 78 render the promotional block flattened.
 *
 * This repairs the body of existing posts and nothing else: no relations, no
 * featured image, no publication state.
 *
 *   node scripts/woocommerce-importer/migration-v2/blog-repair.js --dry-run --all
 *   node scripts/woocommerce-importer/migration-v2/blog-repair.js --dry-run --ids 918313
 *   node scripts/woocommerce-importer/migration-v2/blog-repair.js --apply --slugs clothing-colors-for-wheat-skin
 */

const fs = require("node:fs");
const path = require("node:path");
const { buildConfig } = require("../catalog/config");
const { WordPressSource } = require("./lib/source");
const { Destination } = require("./lib/destination");
const { mapPoolOrdered } = require("../catalog/lib/concurrency");
const { transformBlogContent } = require("./lib/blogContent");

function splitList(value) {
  return String(value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    apply: false,
    all: false,
    ids: null,
    slugs: null,
    env: "production",
    concurrency: 2,
    limit: null,
    jsonOut: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--dry-run") options.dryRun = true;
    else if (token === "--apply") options.apply = true;
    else if (token === "--all") options.all = true;
    else if (token === "--ids") { options.ids = splitList(next); i += 1; }
    else if (token === "--slugs") { options.slugs = splitList(next); i += 1; }
    else if (token === "--env") { options.env = next; i += 1; }
    else if (token === "--concurrency") { options.concurrency = Number(next); i += 1; }
    else if (token === "--limit") { options.limit = Number(next); i += 1; }
    else if (token === "--json-out") { options.jsonOut = next; i += 1; }
    else if (token === "--help" || token === "-h") options.help = true;
    else throw new Error(`Unexpected argument: ${token}`);
  }
  if (options.help) return options;
  if (options.dryRun === options.apply) throw new Error("Specify exactly one of --dry-run or --apply");
  const selections = [options.all, Boolean(options.ids), Boolean(options.slugs)].filter(Boolean);
  if (selections.length !== 1) throw new Error("Specify exactly one of --all, --ids or --slugs");
  if (options.ids && options.ids.some((id) => !/^\d+$/.test(id))) {
    throw new Error("--ids expects numeric WordPress post ids");
  }
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) {
    throw new Error("--concurrency must be an integer between 1 and 8");
  }
  if (options.limit !== null && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }
  return options;
}

/** WordPress `/shop/<slug>/` → Infinity `/plp/category/<slug>` for known categories. */
async function loadCategoryRoutes(destination) {
  const routes = new Map();
  try {
    const categories = await destination.loadSnapshot("productCategories");
    for (const row of categories) {
      const attributes = row?.attributes || row || {};
      const slug = String(attributes.Slug || "").trim();
      if (slug) routes.set(slug, `/plp/category/${encodeURIComponent(slug)}`);
    }
  } catch {
    // Without the snapshot the CTA keeps its absolute WordPress link and the
    // post is reported with PROMO_CTA_CATEGORY_UNRESOLVED.
  }
  return routes;
}

async function collectPosts(source, options) {
  const posts = [];
  if (options.ids) {
    for (const id of options.ids) posts.push(await source.getPost(id));
    return posts;
  }
  const wanted = options.slugs ? new Set(options.slugs) : null;
  for await (const page of source.posts()) {
    for (const post of page.rows) {
      if (wanted && !wanted.has(String(post.slug || ""))) continue;
      posts.push(post);
      if (options.limit && posts.length >= options.limit) return posts;
    }
  }
  return posts;
}

async function run({ source, destination, options }) {
  const routes = await loadCategoryRoutes(destination);
  const resolveCategoryRoute = (slug) => routes.get(slug) || null;
  const snapshot = await destination.loadSnapshot("blogPosts");
  const bySlug = new Map();
  for (const row of snapshot) {
    const attributes = row?.attributes || row || {};
    const slug = String(attributes.Slug || "").trim();
    if (slug) bySlug.set(slug, { id: Number(row.id ?? attributes.id), Content: attributes.Content || "" });
  }

  const posts = await collectPosts(source, options);
  const report = {
    mode: options.dryRun ? "dry-run" : "apply",
    generatedAt: new Date().toISOString(),
    examined: 0,
    withCarousels: 0,
    withPromos: 0,
    changed: 0,
    unchanged: 0,
    notInDestination: 0,
    unresolved: 0,
    failed: 0,
    imagesPending: 0,
    diagnostics: {},
    samples: [],
    failures: [],
  };
  const imageCache = new Map();
  const uploadImage = options.apply
    ? async (sourceUrl, alt) => {
      if (imageCache.has(sourceUrl)) return imageCache.get(sourceUrl);
      const uploaded = await destination.uploadBlogMedia(sourceUrl, `promo-${imageCache.size + 1}`);
      const value = uploaded?.url ? { id: uploaded.id, url: uploaded.url, alt: String(alt || "") } : null;
      imageCache.set(sourceUrl, value);
      return value;
    }
    // A dry run must not write to the media library, and must never fall back
    // to a WordPress hotlink: the post is reported unresolved instead.
    : undefined;

  await mapPoolOrdered(posts, options.concurrency, async (post) => {
    const sourceId = String(post?.id ?? "");
    report.examined += 1;
    try {
      const view = await source.getPostView(sourceId).catch(() => null);
      const transformed = await transformBlogContent(
        {
          raw: post?.content?.raw || "",
          renderedEdit: post?.content?.rendered || "",
          renderedView: view?.content?.rendered || "",
        },
        { resolveCategoryRoute, uploadImage },
      );
      if (transformed.carousels > 0) report.withCarousels += 1;
      if (transformed.promos > 0) report.withPromos += 1;
      for (const diagnostic of transformed.diagnostics) {
        report.diagnostics[diagnostic] = Number(report.diagnostics[diagnostic] || 0) + 1;
        if (diagnostic === "PROMO_IMAGE_PENDING") report.imagesPending += 1;
      }
      if (transformed.diagnostics.length > 0) report.unresolved += 1;

      const slug = String(post?.slug || "");
      const existing = bySlug.get(slug);
      if (!existing) {
        report.notInDestination += 1;
        return;
      }
      if (existing.Content === transformed.content) {
        report.unchanged += 1;
        return;
      }
      report.changed += 1;
      if (report.samples.length < 25) {
        report.samples.push({
          sourceId,
          slug,
          carousels: transformed.carousels,
          promos: transformed.promos,
          products: transformed.productSlugs.length,
          storedBytes: existing.Content.length,
          repairedBytes: transformed.content.length,
          diagnostics: transformed.diagnostics,
        });
      }
      if (options.apply) {
        // Only the body: relations, featured image and status stay as they are.
        await destination.contentUpsert("/blog-posts", existing.id, { Content: transformed.content });
      }
    } catch (error) {
      report.failed += 1;
      if (report.failures.length < 50) {
        report.failures.push({ sourceId, error: error?.payload?.error || error.message });
      }
    }
  });

  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage:
  node blog-repair.js --dry-run (--all | --ids 1,2 | --slugs a,b) [--env production] [--limit N]
  node blog-repair.js --apply   (--all | --ids 1,2 | --slugs a,b) [--concurrency 1-8] [--json-out path]

Repairs only the blog body: carousels and promotional sections become the
storefront's own blocks. A dry run never uploads media and never writes.
`);
    return;
  }
  const { config } = buildConfig(options.env);
  const source = new WordPressSource(config.source || config);
  const destination = new Destination(config.destination || config);
  const report = await run({ source, destination, options });
  console.log(JSON.stringify(report, null, 2));
  if (options.jsonOut) fs.writeFileSync(path.resolve(options.jsonOut), JSON.stringify(report, null, 2));
  if (report.failed > 0) process.exitCode = 2;
}

module.exports = { parseArgs, run, loadCategoryRoutes };

if (require.main === module) {
  main().catch((error) => {
    console.error(`blog-repair failed: ${error.message}`);
    process.exitCode = 1;
  });
}
