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

async function* limitPages(iterator, limit = Infinity) {
  let remaining = limit;
  for await (const page of iterator) {
    if (remaining <= 0) break;
    const rows = page.rows.slice(0, remaining);
    if (rows.length > 0) yield { ...page, rows };
    remaining -= rows.length;
    if (remaining <= 0) break;
  }
}

async function collectRows(iterator, limit) {
  const rows = [];
  for await (const page of limitPages(iterator, limit)) rows.push(...page.rows);
  return rows;
}

function rowsSource(methodName, rows) {
  return {
    async *[methodName]() {
      yield { page: 1, rows, total: rows.length, totalPages: 1 };
    },
  };
}

async function pooledResults(items, concurrency, action) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await action(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function loadValidCustomerWalletCohort(source, limit, concurrency = 4) {
  const customerRows = [];
  const walletRows = [];
  let rawCustomerRowsScanned = 0;
  let invalidPhoneCandidates = 0;
  let unavailableWalletCandidates = 0;

  for await (const page of source.customers()) {
    const candidates = [];
    for (const customer of page.rows) {
      if (customerRows.length + candidates.length >= limit) break;
      rawCustomerRowsScanned += 1;
      try {
        T.customerPayload(customer);
        candidates.push(customer);
      } catch {
        invalidPhoneCandidates += 1;
      }
    }

    const balances = await pooledResults(candidates, concurrency, async (customer) => {
      try {
        const response = await source.getWalletBalance(customer.id);
        return { ok: true, balance: T.walletBalanceValue(response) };
      } catch {
        return { ok: false };
      }
    });

    for (let index = 0; index < candidates.length; index += 1) {
      if (!balances[index].ok) {
        unavailableWalletCandidates += 1;
        continue;
      }
      customerRows.push(candidates[index]);
      walletRows.push({ id: String(candidates[index].id), balance: balances[index].balance });
    }
    if (customerRows.length >= limit) break;
  }

  return {
    customerRows,
    walletRows,
    rawCustomerRowsScanned,
    invalidPhoneCandidates,
    unavailableWalletCandidates,
  };
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

async function runCatalogDryRun(config, ledger, sampleLimit = null) {
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
  const sampledVariationIds = new Set();
  const pilotVariationIds = new Set();
  const chosenProducts = new Set();
  const candidateKinds = new Set();

  const report = await engine.runSync({
    dryRun: true,
    scope: "full",
    ...(sampleLimit === null ? {} : { limit: sampleLimit, categoryLimit: sampleLimit }),
    observer: {
      onProduct({ wcProduct, wcVariations, stockEligibility }) {
        const variationIds = wcProduct.type === "simple"
          ? [String(wcProduct.id)]
          : wcVariations.map((variation) => String(variation.id));
        variationIds.forEach((id) => sampledVariationIds.add(id));
        if (!stockEligibility.eligible) return;
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
  return { eligibleVariationIds, sampledVariationIds, pilotVariationIds };
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

async function scanUsers(source, destinationIndexes, ledger, limit = Infinity) {
  const outcomes = new Map();
  const validUserIds = new Set();
  const sampledUserIds = new Set();
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

  for await (const page of limitPages(source.customers(), limit)) {
    for (const customer of page.rows) {
      const sourceId = String(customer.id);
      sampledUserIds.add(sourceId);
      ledger.count("users", "source");
      if (customer.__migrationFetchError) {
        setOutcome(ledger, outcomes, "users", sourceId, "failed");
        issueOnce(sourceId, customer.__migrationFetchError);
        continue;
      }
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
  return { validUserIds, sampledUserIds, sourcePhones, phoneOwners: phones, duplicatePhones };
}

async function scanWallets(source, destinationIndexes, userContext, ledger, limit = Infinity) {
  const sampled = Number.isFinite(limit);
  for await (const page of limitPages(source.walletUsers(), limit)) {
    for (const walletUser of page.rows) {
      const sourceId = String(walletUser.id || "");
      ledger.count("wallets", "source");
      try {
        const payload = T.walletPayload(walletUser);
        if (sampled && !userContext.sampledUserIds.has(payload.userSourceId)) {
          ledger.summary.sample.exclusions.walletUserOutsideCustomerSample += 1;
          ledger.count("wallets", "skipped");
          continue;
        }
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
    if (page.page % 25 === 0) {
      ledger.checkpoint("wallets", {
        page: page.page,
        source: ledger.summary.entities.wallets?.source || 0,
      });
    }
  }
}

async function scanOrders(source, destinationIndexes, userContext, catalogContext, ledger, limit = Infinity) {
  const selectedKinds = new Set();
  const sampled = Number.isFinite(limit);
  for await (const page of limitPages(source.orders(), limit)) {
    for (const order of page.rows) {
      const sourceId = String(order.id || "");
      ledger.count("orders", "source");
      try {
        const payload = T.orderPayload(order);
        const customerOutsideSample = Boolean(
          sampled &&
          payload.customerSourceId &&
          !userContext.sampledUserIds.has(payload.customerSourceId)
        );
        const productOutsideSample = Boolean(sampled && payload.items.some(
          (item) => !catalogContext.sampledVariationIds.has(item.variationSourceId),
        ));
        if (customerOutsideSample || productOutsideSample) {
          if (customerOutsideSample) ledger.summary.sample.exclusions.orderCustomerOutsideSample += 1;
          if (productOutsideSample) ledger.summary.sample.exclusions.orderProductOutsideSample += 1;
          ledger.count("orders", "skipped");
          continue;
        }
        if (payload.customerSourceId && !userContext.validUserIds.has(payload.customerSourceId)) {
          throw new Error("ORDER_CUSTOMER_NOT_ELIGIBLE");
        }
        const ineligibleVariation = payload.items.find(
          (item) => !catalogContext.eligibleVariationIds.has(item.variationSourceId),
        );
        if (ineligibleVariation) throw new Error("ORDER_ITEM_PRODUCT_SKIPPED_OR_MISSING");
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
    if (page.page % 20 === 0) {
      ledger.checkpoint("orders", {
        page: page.page,
        source: ledger.summary.entities.orders?.source || 0,
      });
    }
  }
}

async function scanSimpleTaxonomy(iterator, entity, destinationIndex, ledger, titleField, limit = Infinity) {
  const sourceMap = new Map();
  for await (const page of limitPages(iterator, limit)) {
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

async function scanBlog(source, destinationIndexes, ledger, limit = Infinity) {
  const categories = await scanSimpleTaxonomy(
    source.blogCategories(), "blogCategories", destinationIndexes.blogCategoriesBySlug, ledger, "name", limit,
  );
  const tags = await scanSimpleTaxonomy(
    source.blogTags(), "blogTags", destinationIndexes.blogTagsBySlug, ledger, "name", limit,
  );
  const authors = new Map();
  for await (const page of limitPages(source.blogAuthors(), limit)) {
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
  for await (const page of limitPages(source.posts(), limit)) {
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

async function runDryRun({ config, source, destination, ledger, sampleLimit = null }) {
  if (sampleLimit !== null) {
    ledger.summary.sample = {
      limitPerEntity: sampleLimit,
      productVariations: "all variations belonging to the sampled products",
      userCohort: "valid Woo customers with readable wallet balances",
      dependencyHandling: "the first rows are capped strictly; dependencies outside the sample are exclusions",
      exclusions: {
        walletUserOutsideCustomerSample: 0,
        customerPhoneInvalidBeforeCohort: 0,
        walletUnavailableBeforeCohort: 0,
        orderCustomerOutsideSample: 0,
        orderProductOutsideSample: 0,
      },
    };
    ledger.persist();
  }
  const destinationIndexes = await loadDestinationIndexes(destination);
  const limit = sampleLimit ?? Infinity;
  const catalogContext = await runCatalogDryRun(config, ledger, sampleLimit);
  let userContext;
  if (sampleLimit === null) {
    userContext = await scanUsers(source, destinationIndexes, ledger, limit);
    await scanWallets(source, destinationIndexes, userContext, ledger, limit);
  } else {
    const cohort = await loadValidCustomerWalletCohort(source, limit);
    ledger.summary.sample.selection = {
      rawCustomerRowsScanned: cohort.rawCustomerRowsScanned,
    };
    ledger.summary.sample.exclusions.customerPhoneInvalidBeforeCohort =
      cohort.invalidPhoneCandidates;
    ledger.summary.sample.exclusions.walletUnavailableBeforeCohort =
      cohort.unavailableWalletCandidates;
    userContext = await scanUsers(
      rowsSource("customers", cohort.customerRows),
      destinationIndexes,
      ledger,
      limit,
    );
    await scanWallets(
      rowsSource("walletUsers", cohort.walletRows),
      destinationIndexes,
      userContext,
      ledger,
      limit,
    );
  }
  await scanOrders(source, destinationIndexes, userContext, catalogContext, ledger, limit);
  await scanBlog(source, destinationIndexes, ledger, limit);
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

module.exports = {
  runDryRun,
  loadDestinationIndexes,
  loadBlogDestinationIndexes,
  scanUsers,
  scanWallets,
  scanOrders,
  limitPages,
  loadValidCustomerWalletCohort,
};
