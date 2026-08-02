"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { CatalogEngine } = require("../catalog/engine");
const { buildConfig } = require("../catalog/config");
const Logger = require("../utils/Logger");
const T = require("./lib/transforms");

function uniqueIndex(rows, keyFn) {
  const map = new Map();
  const duplicates = new Set();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    if (map.has(key)) duplicates.add(key);
    else map.set(key, row);
  }
  return { map, duplicates };
}

function sourceAttributes(row) {
  return row?.attributes || row || {};
}

function setOutcome(ledger, outcomes, entity, sourceId, next) {
  const key = String(sourceId);
  const previous = outcomes.get(key);
  if (previous === next) return;
  if (previous) ledger.count(entity, previous, -1);
  outcomes.set(key, next);
  ledger.count(entity, next);
}

function catalogCounterToLedger(ledger, report) {
  for (const [entity, counters] of Object.entries(report.entities)) {
    const source = Object.values(counters).reduce((sum, value) => sum + Number(value || 0), 0);
    ledger.count(entity, "source", source);
    ledger.count(entity, "eligible", source - Number(counters.skipped || 0) - Number(counters.failed || 0));
    ledger.count(entity, "inserted", Number(counters.created || 0));
    ledger.count(entity, "updated", Number(counters.updated || 0));
    ledger.count(entity, "unchanged", Number(counters.unchanged || 0));
    ledger.count(entity, "skipped", Number(counters.skipped || 0));
    ledger.count(entity, "failed", Number(counters.failed || 0));
  }
}

async function runCatalogDryRun(config, ledger) {
  const trackingDir = path.join(config.stateDir, "catalog");
  fs.mkdirSync(trackingDir, { recursive: true, mode: 0o700 });
  const { config: catalogConfig } = buildConfig("production");
  catalogConfig.duplicateTracking.storageDir = trackingDir;
  catalogConfig.catalog.trackingDirAbs = trackingDir;
  catalogConfig.import.images.enableUpload = false;
  catalogConfig.import.videos.enableUpload = false;
  const logger = new Logger({ ...catalogConfig.logging, level: "info" });
  const engine = new CatalogEngine(catalogConfig, logger, { environment: "production" });
  const eligibleVariationIds = new Set();
  const pilotVariationIds = new Set();
  const chosenProducts = new Set();
  const candidateKinds = new Set();

  const report = await engine.runSync({
    dryRun: true,
    scope: "full",
    observer: {
      onProduct({ wcProduct, wcVariations, stockEligibility }) {
        if (!stockEligibility.eligible) return;
        const variationIds = wcProduct.type === "simple"
          ? [String(wcProduct.id)]
          : wcVariations.map((variation) => String(variation.id));
        variationIds.forEach((id) => eligibleVariationIds.add(id));
        const kinds = [];
        if (wcProduct.type === "simple") kinds.push("productSimple");
        else kinds.push("productVariable");
        if (wcProduct.status !== "publish") kinds.push("productDraft");
        if ((wcProduct.attributes || []).length >= 3) kinds.push("productUnusualAttributes");
        if ((wcProduct.meta_data || []).some((meta) => meta.key === "product_size_guide")) {
          kinds.push("productSizeGuide");
        }
        if ((wcProduct.images || []).length >= 4) kinds.push("productLargeGallery");
        for (const kind of kinds) {
          if (candidateKinds.has(kind)) continue;
          candidateKinds.add(kind);
          ledger.candidate(kind, wcProduct.id);
          chosenProducts.add(String(wcProduct.id));
          variationIds.forEach((id) => pilotVariationIds.add(id));
        }
      },
    },
  });
  catalogCounterToLedger(ledger, report.toJSON());
  ledger.summary.catalog = report.toJSON();
  ledger.summary.candidates.products = Array.from(chosenProducts);
  ledger.summary.candidates.pilotVariationIds = Array.from(pilotVariationIds);
  return { eligibleVariationIds, pilotVariationIds };
}

async function loadDestinationIndexes(destination) {
  const [users, wallets, orders, blogPosts, blogCategories, blogTags, blogAuthors] = await Promise.all([
    destination.loadSnapshot("users"),
    destination.loadSnapshot("wallets"),
    destination.loadSnapshot("orders"),
    destination.loadSnapshot("blogPosts"),
    destination.loadSnapshot("blogCategories"),
    destination.loadSnapshot("blogTags"),
    destination.loadSnapshot("blogAuthors"),
  ]);
  const userRows = users.map(sourceAttributes);
  return {
    usersBySource: uniqueIndex(userRows, (row) => row.external_source === "wordpress" ? String(row.external_id || "") : ""),
    usersByPhone: uniqueIndex(userRows, (row) => T.canonicalPhone(row.phone)),
    usersByEmail: uniqueIndex(userRows, (row) => String(row.email || "").trim().toLowerCase()),
    walletsByUserSource: uniqueIndex(wallets.map(sourceAttributes), (row) => {
      const user = sourceAttributes(row.user);
      return user.external_source === "wordpress" ? String(user.external_id || "") : "";
    }),
    ordersBySource: uniqueIndex(orders.map(sourceAttributes), (row) => row.external_source === "woocommerce" ? String(row.external_id || "") : ""),
    blogPostsBySlug: uniqueIndex(blogPosts.map(sourceAttributes), (row) => String(row.Slug || "")),
    blogCategoriesBySlug: uniqueIndex(blogCategories.map(sourceAttributes), (row) => String(row.Slug || "")),
    blogTagsBySlug: uniqueIndex(blogTags.map(sourceAttributes), (row) => String(row.Slug || "")),
    blogAuthorsByName: uniqueIndex(blogAuthors.map(sourceAttributes), (row) => String(row.Name || "").trim()),
  };
}

async function scanUsers(source, destinationIndexes, ledger) {
  const outcomes = new Map();
  const validUserIds = new Set();
  const phones = new Map();
  const emails = new Map();
  const duplicatePhones = new Set();
  const duplicateEmails = new Set();
  const sourcePhones = new Map();
  const reportedIssues = new Set();
  const issueOnce = (sourceId, code) => {
    const key = `${sourceId}:${code}`;
    if (reportedIssues.has(key)) return;
    reportedIssues.add(key);
    ledger.issue("users", sourceId, code);
  };

  for await (const page of source.customers()) {
    for (const customer of page.rows) {
      const sourceId = String(customer.id);
      ledger.count("users", "source");
      let payload;
      try {
        payload = T.customerPayload(customer);
      } catch (error) {
        setOutcome(ledger, outcomes, "users", sourceId, "failed");
        ledger.issue("users", sourceId, error.message);
        continue;
      }
      sourcePhones.set(sourceId, payload.phone);
      const email = String(payload.email || "").trim().toLowerCase();
      const duplicatePhoneOwner = phones.get(payload.phone);
      if (duplicatePhones.has(payload.phone) || (duplicatePhoneOwner && duplicatePhoneOwner !== sourceId)) {
        if (duplicatePhoneOwner) {
          setOutcome(ledger, outcomes, "users", duplicatePhoneOwner, "failed");
          if (validUserIds.delete(duplicatePhoneOwner)) ledger.count("users", "eligible", -1);
          ledger.candidate("userDuplicateConflict", duplicatePhoneOwner);
          issueOnce(duplicatePhoneOwner, "USER_DUPLICATE_PHONE");
        }
        setOutcome(ledger, outcomes, "users", sourceId, "failed");
        duplicatePhones.add(payload.phone);
        ledger.candidate("userDuplicateConflict", sourceId);
        issueOnce(sourceId, "USER_DUPLICATE_PHONE");
        continue;
      }
      phones.set(payload.phone, sourceId);
      if (email) {
        const duplicateEmailOwner = emails.get(email);
        if (duplicateEmails.has(email) || (duplicateEmailOwner && duplicateEmailOwner !== sourceId)) {
          if (duplicateEmailOwner) {
            setOutcome(ledger, outcomes, "users", duplicateEmailOwner, "failed");
            if (validUserIds.delete(duplicateEmailOwner)) ledger.count("users", "eligible", -1);
            ledger.candidate("userDuplicateConflict", duplicateEmailOwner);
            issueOnce(duplicateEmailOwner, "USER_DUPLICATE_EMAIL");
          }
          setOutcome(ledger, outcomes, "users", sourceId, "failed");
          duplicateEmails.add(email);
          ledger.candidate("userDuplicateConflict", sourceId);
          issueOnce(sourceId, "USER_DUPLICATE_EMAIL");
          continue;
        }
        emails.set(email, sourceId);
      }

      const sourceExisting = destinationIndexes.usersBySource.map.get(sourceId);
      const phoneExisting = destinationIndexes.usersByPhone.map.get(payload.phone);
      if (
        destinationIndexes.usersBySource.duplicates.has(sourceId) ||
        destinationIndexes.usersByPhone.duplicates.has(payload.phone) ||
        (sourceExisting && phoneExisting && Number(sourceExisting.id) !== Number(phoneExisting.id))
      ) {
        setOutcome(ledger, outcomes, "users", sourceId, "failed");
        issueOnce(sourceId, "DESTINATION_USER_MATCH_AMBIGUOUS");
        continue;
      }
      const destinationEmail = email ? destinationIndexes.usersByEmail.map.get(email) : null;
      const matchedId = Number(sourceExisting?.id || phoneExisting?.id || 0);
      if (
        (email && destinationIndexes.usersByEmail.duplicates.has(email)) ||
        (destinationEmail && Number(destinationEmail.id) !== matchedId)
      ) {
        setOutcome(ledger, outcomes, "users", sourceId, "failed");
        issueOnce(sourceId, "DESTINATION_USER_EMAIL_CONFLICT");
        continue;
      }
      ledger.count("users", "eligible");
      validUserIds.add(sourceId);
      setOutcome(ledger, outcomes, "users", sourceId, matchedId ? "updated" : "inserted");
      if (!ledger.summary.candidates.userInsert && !matchedId) {
        ledger.candidate("userInsert", sourceId);
      }
    }
    if (page.page % 25 === 0) ledger.checkpoint("users", { page: page.page, source: ledger.summary.entities.users.source });
  }
  return { validUserIds, sourcePhones, phoneOwners: phones, duplicatePhones };
}

async function scanWallets(source, destinationIndexes, userContext, ledger) {
  for await (const page of source.walletUsers()) {
    for (const walletUser of page.rows) {
      const sourceId = String(walletUser.id || "");
      ledger.count("wallets", "source");
      try {
        const payload = T.walletPayload(walletUser);
        if (!userContext.validUserIds.has(payload.userSourceId)) {
          ledger.count("wallets", "skipped");
          continue;
        }
        ledger.count("wallets", "eligible");
        const existing = destinationIndexes.walletsByUserSource.map.get(payload.userSourceId);
        if (destinationIndexes.walletsByUserSource.duplicates.has(payload.userSourceId)) {
          ledger.failure("wallets", sourceId, "DESTINATION_WALLET_AMBIGUOUS");
        } else if (existing && String(existing.Balance) === payload.balanceRial) {
          ledger.count("wallets", "unchanged");
        } else {
          ledger.count("wallets", existing ? "updated" : "inserted");
        }
        const candidateKind = payload.balanceRial === "0" ? "walletZero" : "walletNonZero";
        if (!(ledger.summary.candidates[candidateKind] || []).length) {
          ledger.candidate(candidateKind, sourceId);
        }
      } catch (error) {
        ledger.failure("wallets", sourceId, error.message);
      }
    }
    if (page.page % 25 === 0) ledger.checkpoint("wallets", { page: page.page, source: ledger.summary.entities.wallets.source });
  }
}

async function scanOrders(source, destinationIndexes, userContext, catalogContext, ledger) {
  const selectedKinds = new Set();
  for await (const page of source.orders()) {
    for (const order of page.rows) {
      const sourceId = String(order.id || "");
      ledger.count("orders", "source");
      try {
        const payload = T.orderPayload(order);
        if (payload.customerSourceId && !userContext.validUserIds.has(payload.customerSourceId)) {
          throw new Error("ORDER_CUSTOMER_NOT_ELIGIBLE");
        }
        const missingVariation = payload.items.find(
          (item) => !catalogContext.eligibleVariationIds.has(item.variationSourceId),
        );
        if (missingVariation) throw new Error("ORDER_ITEM_PRODUCT_SKIPPED_OR_MISSING");
        if (
          payload.guestPhone &&
          (userContext.duplicatePhones.has(payload.guestPhone) ||
            userContext.phoneOwners.get(payload.guestPhone) === undefined)
        ) {
          payload.guestPhone = null;
        }
        ledger.count("orders", "eligible");
        const existing = destinationIndexes.ordersBySource.map.get(sourceId);
        if (destinationIndexes.ordersBySource.duplicates.has(sourceId)) {
          ledger.failure("orders", sourceId, "DESTINATION_ORDER_AMBIGUOUS");
          continue;
        }
        ledger.count("orders", existing ? "updated" : "inserted");
        const usesPilotProducts = payload.items.every((item) => catalogContext.pilotVariationIds.has(item.variationSourceId));
        if (usesPilotProducts) {
          const kind = payload.customerSourceId ? `orderRegistered:${payload.status}` : `orderGuest:${payload.status}`;
          if (!selectedKinds.has(kind)) {
            selectedKinds.add(kind);
            ledger.candidate(kind, sourceId);
            ledger.candidate("orders", sourceId);
          }
        }
      } catch (error) {
        ledger.failure("orders", sourceId, error.message);
      }
    }
    if (page.page % 20 === 0) ledger.checkpoint("orders", { page: page.page, source: ledger.summary.entities.orders.source });
  }
}

async function scanSimpleTaxonomy(iterator, entity, destinationIndex, ledger, titleField) {
  const sourceMap = new Map();
  for await (const page of iterator) {
    for (const row of page.rows) {
      const sourceId = String(row.id);
      const slug = String(row.slug || "").trim();
      const title = String(row[titleField]?.rendered ?? row[titleField] ?? row.name ?? "").trim();
      ledger.count(entity, "source");
      if (!slug || !title) {
        ledger.failure(entity, sourceId, "TAXONOMY_REQUIRED_FIELD_MISSING");
        continue;
      }
      ledger.count(entity, "eligible");
      ledger.count(entity, destinationIndex.map.has(slug) ? "updated" : "inserted");
      sourceMap.set(sourceId, row);
    }
  }
  return sourceMap;
}

async function scanBlog(source, destinationIndexes, ledger) {
  const categories = await scanSimpleTaxonomy(
    source.blogCategories(), "blogCategories", destinationIndexes.blogCategoriesBySlug, ledger, "name",
  );
  const tags = await scanSimpleTaxonomy(
    source.blogTags(), "blogTags", destinationIndexes.blogTagsBySlug, ledger, "name",
  );
  const authors = new Map();
  for await (const page of source.blogAuthors()) {
    for (const author of page.rows) {
      const sourceId = String(author.id);
      const name = String(author.name || "").trim();
      ledger.count("blogAuthors", "source");
      if (!name) {
        ledger.failure("blogAuthors", sourceId, "BLOG_AUTHOR_NAME_MISSING");
        continue;
      }
      ledger.count("blogAuthors", "eligible");
      ledger.count("blogAuthors", destinationIndexes.blogAuthorsByName.map.has(name) ? "updated" : "inserted");
      authors.set(sourceId, author);
    }
  }
  const mediaRefs = new Set();
  const selected = new Set();
  for await (const page of source.posts()) {
    for (const post of page.rows) {
      const sourceId = String(post.id);
      ledger.count("blogPosts", "source");
      try {
        const payload = T.blogPostPayload(post);
        if (payload.categoryIds.some((id) => !categories.has(id))) throw new Error("BLOG_CATEGORY_MISSING");
        if (payload.tagIds.some((id) => !tags.has(id))) throw new Error("BLOG_TAG_MISSING");
        if (payload.authorId && !authors.has(payload.authorId)) throw new Error("BLOG_AUTHOR_MISSING");
        ledger.count("blogPosts", "eligible");
        ledger.count("blogPosts", destinationIndexes.blogPostsBySlug.map.has(payload.data.Slug) ? "updated" : "inserted");
        if (payload.featuredMediaId) mediaRefs.add(payload.featuredMediaId);
        const kinds = [
          `blog:${payload.data.Status}`,
          ...(payload.featuredMediaId ? ["blog:featuredMedia"] : []),
          ...(/[\u0600-\u06ff]/.test(payload.data.Content) ? ["blog:persian"] : []),
        ];
        for (const kind of kinds) {
          if (selected.has(kind)) continue;
          selected.add(kind);
          ledger.candidate(kind, sourceId);
          ledger.candidate("blogPosts", sourceId);
        }
      } catch (error) {
        ledger.failure("blogPosts", sourceId, error.message);
      }
    }
  }
  ledger.count("blogMedia", "source", mediaRefs.size);
  ledger.count("blogMedia", "eligible", mediaRefs.size);
  ledger.count("blogMedia", "inserted", mediaRefs.size);
  ledger.summary.blogMediaReferences = mediaRefs.size;
}

async function runDryRun({ config, source, destination, ledger }) {
  const destinationIndexes = await loadDestinationIndexes(destination);
  const catalogContext = await runCatalogDryRun(config, ledger);
  const userContext = await scanUsers(source, destinationIndexes, ledger);
  await scanWallets(source, destinationIndexes, userContext, ledger);
  await scanOrders(source, destinationIndexes, userContext, catalogContext, ledger);
  await scanBlog(source, destinationIndexes, ledger);
  ledger.summary.metrics = {
    source: source.metrics(),
    destination: destination.metrics(),
  };
  ledger.persist();
  return ledger.summary;
}

async function loadBlogDestinationIndexes(destination) {
  const [blogPosts, blogCategories, blogTags, blogAuthors] = await Promise.all([
    destination.loadSnapshot("blogPosts"),
    destination.loadSnapshot("blogCategories"),
    destination.loadSnapshot("blogTags"),
    destination.loadSnapshot("blogAuthors"),
  ]);
  return {
    blogPostsBySlug: uniqueIndex(blogPosts.map(sourceAttributes), (row) => String(row.Slug || "")),
    blogCategoriesBySlug: uniqueIndex(blogCategories.map(sourceAttributes), (row) => String(row.Slug || "")),
    blogTagsBySlug: uniqueIndex(blogTags.map(sourceAttributes), (row) => String(row.Slug || "")),
    blogAuthorsByName: uniqueIndex(blogAuthors.map(sourceAttributes), (row) => String(row.Name || "").trim()),
  };
}

module.exports = { runDryRun, loadDestinationIndexes, loadBlogDestinationIndexes, scanUsers };
