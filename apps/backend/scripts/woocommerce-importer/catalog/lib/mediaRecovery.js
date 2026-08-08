"use strict";

const fs = require("fs");
const path = require("path");
const { splitWcMediaItems } = require("../../utils/mediaUtils");
const { canonicalSourceUrl, sha256 } = require("./mediaMappingStore");
const { mapPoolOrdered } = require("./concurrency");

function attrs(value) {
  return value?.attributes || value || {};
}

function one(value) {
  const raw = value && Object.prototype.hasOwnProperty.call(value, "data") ? value.data : value;
  return Array.isArray(raw) ? raw[0] || null : raw || null;
}

function many(value) {
  const raw = value && Object.prototype.hasOwnProperty.call(value, "data") ? value.data : value;
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

function sourceHashFor(url) {
  try {
    return sha256(canonicalSourceUrl(url));
  } catch {
    return null;
  }
}

function deterministicName(url) {
  try {
    const hash = sha256(canonicalSourceUrl(url));
    let ext = ".jpg";
    try {
      const pathname = new URL(url).pathname;
      const match = pathname.match(/(\.[a-z0-9]{2,5})$/i);
      if (match) ext = match[1].toLowerCase() === ".jpeg" ? ".jpg" : match[1].toLowerCase();
    } catch {
      // keep default
    }
    return `wc-src-${hash}${ext}`;
  } catch {
    return null;
  }
}

function matchByIdentity(sourceUrl, destinationFile, productId, position) {
  const file = attrs(destinationFile);
  const id = destinationFile?.id ?? file.id;
  const name = String(file.name || "");
  const expectedHash = sourceHashFor(sourceUrl);
  const expectedName = deterministicName(sourceUrl);
  const legacyCover = `product-${productId}-cover-`;
  const legacyGallery = position.startsWith("gallery:")
    ? `product-${productId}-gallery-${position.split(":")[1]}-`
    : null;

  if (!id) {
    return {
      ok: false,
      quarantine: {
        productId: String(productId),
        position,
        sourceHash: expectedHash,
        candidateIds: [],
        reason: "DESTINATION_MEDIA_MISSING",
      },
    };
  }

  const matchesDeterministic =
    Boolean(expectedName) && (name === expectedName || (expectedHash && name.startsWith(`wc-src-${expectedHash}`)));
  const matchesLegacy =
    (position === "cover" && name.startsWith(legacyCover)) ||
    (legacyGallery && name.startsWith(legacyGallery));

  if (matchesDeterministic || matchesLegacy) {
    return { ok: true, sourceUrl, id, name, mime: file.mime || null };
  }

  return {
    ok: false,
    quarantine: {
      productId: String(productId),
      position,
      sourceHash: expectedHash,
      candidateIds: [id],
      reason: "SOURCE_IDENTITY_MISMATCH",
    },
  };
}

/**
 * Legacy audit: seed URL→file mappings from unambiguous existing attachments.
 * Supports both `wc-src-{hash}` and legacy `product-{id}-cover-` filenames.
 */
async function auditLegacyMedia({ runStore, runId, woo, repo, mediaStore, dryRun = true, confirm = "" }) {
  if (!dryRun && confirm !== "CatalogMediaRecovery") {
    throw new Error("Confirmed media recovery requires --confirm CatalogMediaRecovery");
  }
  const run = runStore.getRun(runId);
  const completedProductIds = Object.values(run.items || {})
    .filter((item) => item.entity === "products" && item.status === "completed" && item.wcId !== undefined)
    .map((item) => String(item.wcId));
  const completedProductSet = new Set(completedProductIds);
  const productIndex = await repo.buildExternalIndex("/products", {
    "populate[CoverImage][fields][0]": "id",
    "populate[CoverImage][fields][1]": "name",
    "populate[CoverImage][fields][2]": "mime",
    "populate[Media][fields][0]": "id",
    "populate[Media][fields][1]": "name",
    "populate[Media][fields][2]": "mime",
  });
  const seeds = [];
  const quarantine = [];
  const seenSourceProducts = new Set();
  let sourceProductsScanned = 0;
  for await (const sourceProduct of woo.iterateProducts({
    perPage: 100,
    params: { _fields: "id,images" },
  })) {
    sourceProductsScanned += 1;
    const productId = String(sourceProduct?.id ?? "");
    if (!completedProductSet.has(productId)) continue;
    seenSourceProducts.add(productId);
    const destination = productIndex.get(productId);
    if (!destination) {
      quarantine.push({ productId, position: "product", sourceHash: null, candidateIds: [], reason: "PRODUCT_SIDE_MISSING" });
      continue;
    }
    const images = splitWcMediaItems(sourceProduct.images || [], ["mp4", "webm", "mov", "m4v"]).images;
    const destinationAttrs = attrs(destination);
    if (images[0]) {
      const result = matchByIdentity(images[0].src, one(destinationAttrs.CoverImage), productId, "cover");
      if (result.ok) seeds.push(result); else quarantine.push(result.quarantine);
    }
    const gallery = many(destinationAttrs.Media);
    for (let index = 1; index < images.length; index += 1) {
      const result = matchByIdentity(
        images[index].src,
        gallery[index - 1],
        productId,
        `gallery:${index}`,
      );
      if (result.ok) seeds.push(result); else quarantine.push(result.quarantine);
    }
  }
  for (const productId of completedProductIds) {
    if (!seenSourceProducts.has(productId)) {
      quarantine.push({ productId, position: "product", sourceHash: null, candidateIds: [], reason: "PRODUCT_SIDE_MISSING" });
    }
  }
  if (!dryRun) {
    for (const seed of seeds) mediaStore.set("media", seed.sourceUrl, seed.id, { name: seed.name, mime: seed.mime, recovered: true });
    mediaStore.syncBoundary();
    if (quarantine.length > 0) {
      const quarantinePath = path.join(mediaStore.dir, "recovery-quarantine.ndjson");
      fs.mkdirSync(mediaStore.dir, { recursive: true, mode: 0o700 });
      const fd = fs.openSync(quarantinePath, "a", 0o600);
      try {
        for (const row of quarantine) fs.writeSync(fd, `${JSON.stringify({ ...row, timestamp: new Date().toISOString() })}\n`);
        fs.fdatasyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  return {
    runId,
    dryRun,
    sourceProductsScanned,
    completedProducts: completedProductIds.length,
    unambiguousMappings: seeds.length,
    quarantined: quarantine.length,
    quarantine,
  };
}

function destinationHasCover(destination) {
  const cover = one(attrs(destination).CoverImage);
  const id = cover?.id ?? attrs(cover).id ?? cover;
  return Boolean(id);
}

/**
 * Identify Woo products that have source images but missing/incomplete Strapi media,
 * then optionally repair via MediaSync (preserve good media; never null relations).
 */
async function reconcileMissingProductMedia({
  woo,
  repo,
  media,
  logger = { info() {}, warn() {}, error() {} },
  dryRun = true,
  confirm = "",
  limit = Infinity,
  concurrency = 2,
  startAfterExternalId = null,
}) {
  if (!dryRun && confirm !== "CatalogMediaRepair") {
    throw new Error("Confirmed media repair requires --confirm CatalogMediaRepair");
  }

  const productIndex = await repo.buildExternalIndex("/products", {
    "populate[CoverImage][fields][0]": "id",
    "populate[CoverImage][fields][1]": "name",
    "populate[Media][fields][0]": "id",
    "populate[Media][fields][1]": "name",
  });

  const needsRepair = [];
  let sourceProductsScanned = 0;
  let sourceWithImages = 0;
  let targetMissingMedia = 0;

  for await (const sourceProduct of woo.iterateProducts({
    perPage: 100,
    params: { _fields: "id,name,sku,images,status" },
  })) {
    sourceProductsScanned += 1;
    const productId = String(sourceProduct?.id ?? "");
    if (startAfterExternalId && Number(productId) <= Number(startAfterExternalId)) continue;

    const images = splitWcMediaItems(sourceProduct.images || [], ["mp4", "webm", "mov", "m4v"]).images;
    if (images.length === 0) continue;
    sourceWithImages += 1;

    const destination = productIndex.get(productId);
    if (!destination) {
      needsRepair.push({
        wcId: productId,
        reason: "PRODUCT_SIDE_MISSING",
        sourceImageCount: images.length,
        sourceProduct,
        destination: null,
      });
      targetMissingMedia += 1;
      if (needsRepair.length >= limit) break;
      continue;
    }

    const hasCover = destinationHasCover(destination);
    const gallery = many(attrs(destination).Media);
    const expectedGallery = Math.max(0, images.length - 1);
    const incomplete = !hasCover || (expectedGallery > 0 && gallery.length < expectedGallery);

    if (incomplete) {
      needsRepair.push({
        wcId: productId,
        reason: !hasCover ? "COVER_MISSING" : "GALLERY_INCOMPLETE",
        sourceImageCount: images.length,
        targetCover: hasCover,
        targetGalleryCount: gallery.length,
        sourceProduct,
        destination,
      });
      targetMissingMedia += 1;
    }

    if (needsRepair.length >= limit) break;
  }

  const summary = {
    dryRun,
    sourceProductsScanned,
    sourceWithImages,
    targetMissingMedia,
    candidates: needsRepair.length,
    repaired: 0,
    imagesUploaded: 0,
    imagesReused: 0,
    imagesFailed: 0,
    unresolved: [],
  };

  if (dryRun) {
    summary.unresolved = needsRepair.map((row) => ({
      wcId: row.wcId,
      reason: row.reason,
      sourceImageCount: row.sourceImageCount,
    }));
    return summary;
  }

  const repairable = needsRepair.filter((row) => row.destination?.id);
  const results = await mapPoolOrdered(repairable, concurrency, async (row) => {
    try {
      const mediaResult = await media.syncProductMedia(row.sourceProduct);
      const { coverId, galleryIds, counts, complete, failures = {} } = mediaResult;
      summary.imagesUploaded += counts.uploaded || 0;
      summary.imagesReused += counts.reused || 0;
      summary.imagesFailed += counts.failed || 0;

      const update = {};
      if (coverId) update.CoverImage = coverId;
      const hadGallery = many(attrs(row.destination).Media).length > 0;
      if (galleryIds.length > 0 && !(failures.gallery && hadGallery)) {
        update.Media = galleryIds;
      }
      if (Object.keys(update).length > 0) {
        await repo.http.put(`/products/${row.destination.id}`, { data: update });
      }

      if (!complete) {
        return {
          ok: false,
          wcId: row.wcId,
          reason: "MEDIA_STILL_INCOMPLETE",
          error: mediaResult.failureDetails?.[0]?.error || "incomplete",
        };
      }
      summary.repaired += 1;
      logger.info(`✅ repaired media for WC product ${row.wcId}`);
      return { ok: true, wcId: row.wcId };
    } catch (error) {
      summary.imagesFailed += 1;
      return { ok: false, wcId: row.wcId, reason: "REPAIR_EXCEPTION", error: error.message };
    }
  });

  for (const row of needsRepair.filter((item) => !item.destination?.id)) {
    summary.unresolved.push({ wcId: row.wcId, reason: row.reason });
  }
  for (const result of results) {
    if (!result.ok) summary.unresolved.push(result);
  }

  return summary;
}

module.exports = {
  auditLegacyMedia,
  reconcileMissingProductMedia,
  matchByIdentity,
};
