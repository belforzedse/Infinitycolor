"use strict";

const fs = require("fs");
const path = require("path");
const { splitWcMediaItems } = require("../../utils/mediaUtils");
const { canonicalSourceUrl, sha256 } = require("./mediaMappingStore");

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

function candidate(sourceUrl, destination, expectedPrefix, productId, position) {
  const file = attrs(destination);
  const id = destination?.id ?? file.id;
  const name = String(file.name || "");
  if (!id || !name.startsWith(expectedPrefix)) {
    return {
      ok: false,
      quarantine: {
        productId: String(productId),
        position,
        sourceHash: sha256(canonicalSourceUrl(sourceUrl)),
        candidateIds: id ? [id] : [],
        reason: id ? "LEGACY_FILENAME_PREFIX_MISMATCH" : "DESTINATION_MEDIA_MISSING",
      },
    };
  }
  return { ok: true, sourceUrl, id, name, mime: file.mime || null };
}

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
      const result = candidate(images[0].src, one(destinationAttrs.CoverImage), `product-${productId}-cover-`, productId, "cover");
      if (result.ok) seeds.push(result); else quarantine.push(result.quarantine);
    }
    const gallery = many(destinationAttrs.Media);
    for (let index = 1; index < images.length; index += 1) {
      const result = candidate(
        images[index].src,
        gallery[index - 1],
        `product-${productId}-gallery-${index}-`,
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

module.exports = { auditLegacyMedia };
