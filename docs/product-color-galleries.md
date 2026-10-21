# Product color photos

In the custom admin, create the product's variations first. Open **کلی → تصاویر هر رنگ**, choose or upload images for a color, drag the image handles to set their order, then save the product. Include product and on-model/fit photos in the same ordered list. An empty color gallery uses the existing cover and product media.

`product.ColorGalleries` is a repeatable `product.color-gallery` component containing a shared `color` relation and ordered `Images` media. It belongs to the product, independently of size/model variation rows. Existing products need no data backfill. Restart Strapi after pulling the component schema so its normal schema synchronization creates the component storage.

The guarded editor snapshot reads and writes the mapping. Writes retain lease/revision checks, attachment locks and `product.media.manage`; component IDs from another product are rejected. The media library includes color-only attachments in product search/usage and prevents deleting or replacing in-use files.

The storefront uses the same initial color selection as the variation controls. A color change resets only the existing gallery to that color's first image. Size/model changes preserve the current photo and keep existing stock, price, SKU and cart behavior. Missing/empty color galleries use only the product-wide gallery. Public full and shell product responses include both nested relations.

## Focused verification

- Backend: product-color-galleries, product-editor-snapshot, product-by-slug, product lifecycles, catalogOwnership, media-library-query, media-library controller and upload extension suites.
- Admin: ColorGalleries, editor-payload and editor-session suites, type check and architecture check.
- Frontend: color-gallery, InfoSelection, product helpers and pdp-lookup suites, type check and production build.

The persistence suite boots real Strapi on disposable PostgreSQL. From PowerShell at the repository root:

```powershell
$env:INTEGRATION_DB_MODE = 'testcontainers'
$env:INTEGRATION_PG_IMAGE = 'postgres:16-alpine'
$env:REST_CACHE_PROVIDER = 'memory'
$env:STRAPI_ENABLE_DOCUMENTATION = 'false'
$env:STRAPI_TELEMETRY_DISABLED = 'true'
corepack pnpm --filter @repo/backend test:integration --runTestsByPath src/__tests__/integration/tier1/product-color-galleries.int.spec.ts
```

The browser suite builds an isolated production storefront and runs against a local catalogue fixture on ports **4310/4311**. It does not write to the developer database. It covers phone/desktop RTL, Safe/automatic quality, keyboard controls, zoom, gallery fallback, single-color products, price and guest cart variation selection. Screenshots go to `apps/e2e/test-results/product-color-gallery/`.

```powershell
# Use installed Chrome, or omit this variable with Playwright Chromium installed.
$env:GALLERY_E2E_BROWSER_CHANNEL = 'chrome'
corepack pnpm --filter @repo/e2e exec playwright test --config product-color-gallery.playwright.config.ts
```

`GALLERY_E2E_SKIP_BUILD=true` reuses the isolated build. `GALLERY_E2E_EXTERNAL=true` uses already-running fixture/production servers. The build directory is `apps/frontend/.next-color-gallery-check/`; the normal development build and local `.env` files are preserved.
