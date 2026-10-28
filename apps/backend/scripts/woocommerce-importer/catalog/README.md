# Catalog Importer (`catalog/`)

Idempotent WooCommerce → Strapi catalog sync. **WooCommerce is the read-only source
of truth; Strapi is the writable target.** This is the rewrite of the legacy
`index.js` + `sync/` importers, built around pure, unit-tested mapping functions.

## Durable v2 run state

Tracked runs use a dependency-free append-only layout:

```text
catalog-runs/<runId>/snapshot.json
catalog-runs/<runId>/events.ndjson
catalog-runs/<runId>/control.json
```

The snapshot is loaded once and subsequent events are replayed into an in-memory
projection. Item transitions append to the journal; media mappings are synced
first and the catalog journal is `fdatasync`ed at each product boundary. A sudden
host or power failure can therefore replay at most the active product. Pause,
cancel, fatal, and terminal transitions sync immediately. Compaction is atomic
after 10,000 events, 64 MiB, or terminal completion.

Legacy JSON is never changed by conversion. Preview and confirm offline:

```bash
node catalog-convert.js --run <catalog-run-id> --tracking-dir <catalog-state-dir> --dry-run
node catalog-convert.js --run <catalog-run-id> --tracking-dir <catalog-state-dir> --confirm CatalogStateV2
```

The media recovery audit is source/destination read-only unless its local mapping
journal is explicitly confirmed:

```bash
node catalog-media-recover.js --run <catalog-run-id> --tracking-dir <catalog-state-dir> --dry-run
node catalog-media-recover.js --run <catalog-run-id> --tracking-dir <catalog-state-dir> --confirm CatalogMediaRecovery
```

Operational tradeoffs: custom journal replay/compaction is more complex than one
JSON file; product-boundary sync permits active-product replay; old random media
names can leave ambiguous recovery rows for manual review; bounded parallel media
raises transient CPU, memory, network and database load and makes log ordering
nondeterministic; dual-format support temporarily expands the test surface; and
an interruption between a remote write and its checkpoint may leave orphan media
or repeat an idempotent destination write. Removing the state bottleneck exposes
media conversion/upload as the next limiting stage. SQLite was not selected
because Node 20 Alpine has no built-in `node:sqlite`, while a native dependency
adds ABI/build and WAL-backup risk.

## Commands

```bash
cd apps/backend/scripts/woocommerce-importer

# Preview — no writes
node catalog/cli.js dry-run --env local --limit 20
npm run catalog:dry-run -- --env production

# Apply
node catalog/cli.js sync --env production
npm run catalog:sync -- --env production --skip-media

# Compare stores by external_id
node catalog/cli.js verify --env production

# Tests (no network, no install — Node ≥ 20.9.0 built-in runner)
npm test            # → node --test catalog/__tests__/*.test.js
```

Flags: `--env production|staging|local`, `--limit <n>`, `--skip-categories`,
`--skip-media`, `--log-level error|warn|info|debug`.

## Environment

Reuses the existing importer env vars — no new required vars:

- `WOOCOMMERCE_CONSUMER_KEY`, `WOOCOMMERCE_CONSUMER_SECRET`
- `STRAPI_API_TOKEN_PRODUCTION|STAGING|LOCAL`, `STRAPI_IMPORT_*_URL`
- `CURRENCY_MULTIPLIER`, `IMPORT_BATCH_PRODUCTS`, `IMPORT_ERROR_*`, `IMPORT_IMAGES_*`, `IMPORT_VIDEOS_*`

New optional:

- `IMPORT_STOCK_DEFAULT_INSTOCK_COUNT` (default `9999`) — Count used for in-stock items
  that don't manage stock quantity (so they're purchasable; availability derives from `Count`).
- `IMPORT_MEDIA_ALLOW_HTTP` (`true` to allow plain-http media; auto-on for `--env local`).

## How it works

1. **Idempotency** — every entity is matched by the unique `external_id` field
   (= WooCommerce numeric id). Existing WC-sourced Strapi entities are loaded once
   per run into an in-memory index → upsert (PUT) when matched, create (POST)
   otherwise. A persistent `catalog-mappings.json` (atomic temp+rename) is a
   cache/repair aid, not the source of truth. **Re-runs update, never duplicate.**
2. **Slug** — the exact WooCommerce slug is imported without decoding, trimming,
   normalization, fallback, or regeneration → no per-run drift, SEO URLs preserved.
   Empty Woo slugs remain empty. The destination permits duplicate inactive slugs
   but enforces uniqueness for active, non-removed products so public routes remain
   deterministic.
3. **Prices** — `0` is not "missing"; only-sale-price products keep a price;
   variations fall back to the parent product's price; a brand-new variation with
   no price anywhere is reported as a failure, never written as a `0`-price product.
4. **Stock** — managed quantity used directly; unmanaged items derive `Count` from
   `stock_status` so in-stock items stay purchasable.
5. **Simple products** — get a synthesized default variation (Price/SKU/stock) so
   they're sellable.
6. **Media** — persistent URL→file-id map means each image uploads once and is
   reused forever; an SSRF guard blocks private/loopback/metadata hosts before any
   download; existing `CoverImage`/`Media` is never nulled by a failed re-download.
7. **Reliability** — exponential backoff with jitter, honours `Retry-After`, retries
   only network/429/5xx (never 4xx).
8. **Reporting** — every run prints and saves (`import-tracking/<env>/sync-reports/`)
   created/updated/unchanged/skipped/failed/duplicate counts, media uploaded vs
   reused, total duration, and a failures list where each entry carries the
   WooCommerce id and stage.

## Layout

```
catalog/
  cli.js, engine.js, config.js
  lib/{slug,backoff,safeUrl,transforms,httpClient,wooSource,strapiRepo,mapping,media,report}.js
  __tests__/*.test.js      fixtures/*.json
```

Reused (not rewritten): `../utils/colorMappings.js`, `../utils/mediaUtils.js`,
`../utils/Logger.js`, `../utils/ImageUploader.js` (sharp/WebP), `../data/color-mappings.json`.

## Not covered (yet)

Orders / users / blog importers (catalog only). Grouped/external WC product types
import as products without a purchasable variation (flagged, not synthesized). Media
dedup is by URL, not content hash.
