"use strict";

const CatalogT = require("../catalog/lib/transforms");
const T = require("./lib/transforms");
const {
  wooSourceTimestamps,
  wordpressSourceTimestamps,
} = require("../utils/sourceTimestamps");

function rowsOf(response) {
  return Array.isArray(response?.data) ? response.data : [];
}

function attrs(row) {
  return row?.attributes || row || {};
}

function relationOne(value) {
  const raw = value && Object.prototype.hasOwnProperty.call(value, "data")
    ? value.data
    : value;
  if (Array.isArray(raw)) return raw[0] || null;
  return raw || null;
}

function relationMany(value) {
  const raw = value && Object.prototype.hasOwnProperty.call(value, "data")
    ? value.data
    : value;
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function selectedIds(dryRun, pilot, kind) {
  const explicit = pilot?.pilotSelection?.[kind];
  if (Array.isArray(explicit)) return explicit.map(String);
  const candidateKind = kind === "productIds" ? "products" : kind;
  return Array.isArray(dryRun?.candidates?.[candidateKind])
    ? dryRun.candidates[candidateKind].map(String)
    : [];
}

function mismatch(ledger, entity, sourceId, code) {
  ledger.failure(`${entity}Reconciliation`, sourceId, code);
}

function sameTimestamp(actual, expected) {
  if (!actual || !expected) return false;
  const parsed = new Date(actual);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === expected;
}

function checkSourceTimestamps(check, actual, expected, prefix) {
  if (!expected) return;
  check(sameTimestamp(actual?.createdAt, expected.createdAt), `${prefix}_CREATED_AT_MISMATCH`);
  check(sameTimestamp(actual?.updatedAt, expected.updatedAt), `${prefix}_UPDATED_AT_MISMATCH`);
}

function acceptedExceptionKeys(pilot) {
  return new Set((pilot?.acceptedExceptions?.entries || []).map((entry) => String(entry.key)));
}

async function reconcileProducts(source, destination, dryRun, pilot, ledger) {
  const productIds = selectedIds(dryRun, pilot, "productIds");
  const destinationProducts = (await destination.loadSnapshot("products")).map(attrs);
  const destinationVariations = (await destination.loadSnapshot("variations")).map(attrs);
  const variationsBySource = new Map(
    destinationVariations
      .filter((row) => row.external_source === "woocommerce" && row.external_id)
      .map((row) => [String(row.external_id), row]),
  );
  const acceptedKeys = acceptedExceptionKeys(pilot);
  for (const sourceId of productIds) {
    ledger.count("products", "source");
    const sourceProduct = await source.getProduct(sourceId);
    const matches = destinationProducts.filter(
      (row) => row.external_source === "woocommerce" && String(row.external_id || "") === sourceId,
    );
    if (matches.length !== 1) {
      mismatch(ledger, "products", sourceId, "PRODUCT_NOT_UNIQUE");
      continue;
    }

    // The public product controller intentionally hides inactive products even
    // from API-token requests. Every imported product has at least one real or
    // synthetic variation, so traverse that relation after resolving identity
    // through the unfiltered migration snapshot.
    const destinationResponse = await destination.getContent("/product-variations", {
      "filters[product][id][$eq]": matches[0].id,
      "populate[product][populate][product_size_helper]": "true",
      "pagination[pageSize]": 1,
    });
    const variation = rowsOf(destinationResponse)[0];
    const destinationProductRaw = relationOne(attrs(variation).product);
    const destinationProduct = attrs(destinationProductRaw);
    if (!destinationProductRaw || Number(destinationProductRaw.id) !== Number(matches[0].id)) {
      mismatch(ledger, "products", sourceId, "PRODUCT_RELATION_NOT_FOUND");
      continue;
    }

    let valid = true;
    const check = (condition, code) => {
      if (!condition) {
        valid = false;
        mismatch(ledger, "products", sourceId, code);
      }
    };
    const expectedGuide = CatalogT.extractSizeGuideMatrix(sourceProduct);
    const expectedTimestamps = wooSourceTimestamps(sourceProduct);
    const helper = attrs(destinationProduct.product_size_helper?.data || destinationProduct.product_size_helper);
    const actualGuide = helper?.Helper ?? null;
    check(destinationProduct.Title === CatalogT.normalizeName(sourceProduct.name), "PRODUCT_TITLE_MISMATCH");
    check(destinationProduct.Slug === safeDecode(sourceProduct.slug), "PRODUCT_SLUG_MISMATCH");
    check(JSON.stringify(expectedGuide) === JSON.stringify(actualGuide), "SIZE_GUIDE_MISMATCH");
    checkSourceTimestamps(check, matches[0], expectedTimestamps, "PRODUCT");
    if (expectedTimestamps) {
      check(
        sameTimestamp(matches[0].LastEditedByAdminAt, expectedTimestamps.updatedAt),
        "PRODUCT_MANUAL_EDIT_AT_MISMATCH",
      );
      if (expectedGuide) checkSourceTimestamps(check, helper, expectedTimestamps, "SIZE_HELPER");
    }
    if (valid) ledger.count("products", "verified");

    const sourceVariations = sourceProduct.type === "simple" || !sourceProduct.variations?.length
      ? [CatalogT.synthesizeSimpleVariation(sourceProduct)]
      : await source.getProductVariations(sourceId);
    for (const sourceVariation of sourceVariations) {
      const variationSourceId = String(sourceVariation.id);
      ledger.count("variations", "source");
      if (acceptedKeys.has(`variation:${variationSourceId}`) || acceptedKeys.has(`stock:${variationSourceId}`)) {
        ledger.count("variations", "skipped");
        ledger.issue("variations", variationSourceId, "ACCEPTED_CATALOG_EXCEPTION");
        continue;
      }
      const actualVariation = variationsBySource.get(variationSourceId);
      if (!actualVariation) {
        mismatch(ledger, "variations", variationSourceId, "VARIATION_NOT_FOUND");
        continue;
      }
      const variationTimestamps = wooSourceTimestamps(sourceVariation);
      let variationValid = true;
      const checkVariation = (condition, code) => {
        if (!condition) {
          variationValid = false;
          mismatch(ledger, "variations", variationSourceId, code);
        }
      };
      checkSourceTimestamps(checkVariation, actualVariation, variationTimestamps, "VARIATION");
      if (variationValid) ledger.count("variations", "verified");
    }
  }
}

async function reconcileUsersAndWallets(source, destination, dryRun, pilot, ledger) {
  const userRows = (await destination.loadSnapshot("users")).map(attrs);
  const walletRows = (await destination.loadSnapshot("wallets")).map(attrs);
  const usersBySource = new Map(
    userRows
      .filter((row) => row.external_source === "wordpress" && row.external_id)
      .map((row) => [String(row.external_id), row]),
  );
  const walletsBySource = new Map(walletRows.map((wallet) => {
    const user = attrs(wallet.user);
    return [String(user.external_id || ""), wallet];
  }));
  const userIds = Array.from(new Set(
    selectedIds(dryRun, pilot, "userIds").length > 0
      ? selectedIds(dryRun, pilot, "userIds")
      : [
          ...(dryRun.candidates?.userInsert || []),
          ...(dryRun.candidates?.walletZero || []),
          ...(dryRun.candidates?.walletNonZero || []),
        ].map(String),
  ));
  for (const sourceId of userIds) {
    ledger.count("users", "source");
    const customer = await source.getCustomer(sourceId);
    let expected;
    try { expected = T.customerPayload(customer); } catch { continue; }
    const actual = usersBySource.get(sourceId);
    if (!actual) mismatch(ledger, "users", sourceId, "USER_NOT_FOUND");
    else {
      let valid = true;
      if (T.canonicalPhone(actual.phone) !== expected.phone) {
        valid = false;
        mismatch(ledger, "users", sourceId, "USER_PHONE_MISMATCH");
      }
      const timestamps = expected.sourceCreatedAt ? {
        createdAt: expected.sourceCreatedAt,
        updatedAt: expected.sourceUpdatedAt,
      } : null;
      if (timestamps && (
        !sameTimestamp(actual.SourceCreatedAt, timestamps.createdAt) ||
        !sameTimestamp(actual.SourceUpdatedAt, timestamps.updatedAt)
      )) {
        valid = false;
        mismatch(ledger, "users", sourceId, "USER_SOURCE_TIMESTAMP_MISMATCH");
      }
      if (valid) ledger.count("users", "verified");
    }
  }
  const walletIds = selectedIds(dryRun, pilot, "walletIds");
  for (const sourceId of Array.from(new Set(
    walletIds.length > 0
      ? walletIds
      : [...(dryRun.candidates?.walletZero || []), ...(dryRun.candidates?.walletNonZero || [])].map(String),
  ))) {
    ledger.count("wallets", "source");
    const response = await source.getWalletBalance(sourceId);
    const expected = T.walletPayload({
      id: sourceId,
      balance: T.walletBalanceValue(response),
    });
    const actual = walletsBySource.get(sourceId);
    if (!actual) mismatch(ledger, "wallets", sourceId, "WALLET_NOT_FOUND");
    else if (String(actual.Balance) !== expected.balanceRial) mismatch(ledger, "wallets", sourceId, "WALLET_BALANCE_MISMATCH");
    else ledger.count("wallets", "verified");
  }
}

async function reconcileOrders(source, destination, dryRun, pilot, ledger) {
  const pilotOrders = Array.isArray(pilot?.pilotSelection?.orders)
    ? pilot.pilotSelection.orders
    : (dryRun.candidates?.orders || []).map((sourceId) => ({ sourceId }));
  for (const selectedOrder of pilotOrders) {
    const sourceId = String(selectedOrder.sourceId);
    ledger.count("orders", "source");
    const sourceOrder = await source.getOrder(sourceId);
    const expected = T.orderPayload(sourceOrder);
    const response = await destination.getContent("/orders", {
      "filters[external_source][$eq]": "woocommerce",
      "filters[external_id][$eq]": sourceId,
      "populate[contract]": "true",
      "populate[user]": "true",
      "populate[delivery_address][populate][shipping_city][populate][shipping_province]": "true",
      "populate[order_items][populate][product_variation]": "true",
      "pagination[pageSize]": 2,
    });
    const rows = rowsOf(response);
    if (rows.length !== 1) {
      mismatch(ledger, "orders", sourceId, "ORDER_NOT_UNIQUE");
      continue;
    }
    const actual = attrs(rows[0]);
    const contract = attrs(relationOne(actual.contract));
    const actualItems = relationMany(actual.order_items).map(attrs);
    const itemsBySource = new Map(actualItems.map((item) => [String(item.external_id || ""), item]));
    let valid = true;
    const check = (condition, code) => {
      if (!condition) {
        valid = false;
        mismatch(ledger, "orders", sourceId, code);
      }
    };
    check(actual.Status === expected.status, "ORDER_STATUS_MISMATCH");
    check(new Date(actual.Date).toISOString() === expected.date, "ORDER_DATE_MISMATCH");
    check(String(actual.ShippingCost || 0) === expected.shippingToman, "ORDER_SHIPPING_MISMATCH");
    check(actual.PaymentGateway === expected.paymentGateway, "ORDER_PAYMENT_GATEWAY_MISMATCH");
    if (expected.deliveryAddress) {
      const actualAddress = attrs(relationOne(actual.delivery_address));
      const actualCity = attrs(relationOne(actualAddress.shipping_city));
      const actualProvince = attrs(relationOne(actualCity.shipping_province));
      check(Boolean(relationOne(actual.delivery_address)), "ORDER_ADDRESS_MISSING");
      check(Boolean(String(actualAddress.FullAddress || "").trim()), "ORDER_ADDRESS_LINE_MISSING");
      check(Boolean(String(actualCity.Title || "").trim()), "ORDER_ADDRESS_CITY_MISSING");
      check(Boolean(String(actualProvince.Title || "").trim()), "ORDER_ADDRESS_PROVINCE_MISSING");
    }
    check(actual.Description == null && actual.Note == null, "ORDER_PRIVATE_TEXT_PRESENT");
    check(contract.Status === expected.contractStatus, "ORDER_CONTRACT_STATUS_MISMATCH");
    check(contract.Type === expected.contractType, "ORDER_CONTRACT_TYPE_MISMATCH");
    check(Number(contract.TaxPercent) === expected.taxPercent, "ORDER_CONTRACT_TAX_MISMATCH");
    check(String(contract.Amount) === expected.totalToman, "ORDER_TOTAL_MISMATCH");
    check(actualItems.length === expected.items.length, "ORDER_ITEM_COUNT_MISMATCH");
    const orderTimestamps = expected.sourceCreatedAt ? {
      createdAt: expected.sourceCreatedAt,
      updatedAt: expected.sourceUpdatedAt,
    } : null;
    checkSourceTimestamps(check, actual, orderTimestamps, "ORDER");
    checkSourceTimestamps(check, contract, orderTimestamps, "ORDER_CONTRACT");
    for (const expectedItem of expected.items) {
      const actualItem = itemsBySource.get(`line_item_${expectedItem.sourceId}`);
      if (!actualItem) {
        check(false, "ORDER_ITEM_NOT_FOUND");
        continue;
      }
      const actualVariationNode = relationOne(actualItem.product_variation);
      const actualVariation = attrs(actualVariationNode);
      check(Number(actualItem.Count) === expectedItem.count, "ORDER_ITEM_QUANTITY_MISMATCH");
      check(String(actualItem.PerAmount) === expectedItem.unitPriceToman, "ORDER_ITEM_PRICE_MISMATCH");
      if (expectedItem.catalogReference === "orphan") {
        // The source line has no catalog reference at all, so the imported row
        // must carry the sale snapshot and no invented relation.
        check(!actualVariationNode, "ORDER_ITEM_ORPHAN_HAS_CATALOG_RELATION");
        check(String(actualItem.ProductTitle || "").length > 0, "ORDER_ITEM_TITLE_MISSING");
        check(String(actualItem.ProductSKU || "") === expectedItem.sku, "ORDER_ITEM_SKU_MISMATCH");
      } else {
        check(String(actualVariation.external_id || "") === expectedItem.variationSourceId, "ORDER_ITEM_VARIATION_MISMATCH");
      }
      checkSourceTimestamps(check, actualItem, orderTimestamps, "ORDER_ITEM");
    }
    if (expected.customerSourceId) {
      const actualUser = attrs(relationOne(actual.user));
      check(
        actualUser.external_source === "wordpress" &&
          String(actualUser.external_id || "") === expected.customerSourceId,
        "ORDER_CUSTOMER_MISMATCH",
      );
    } else {
      const actualUser = attrs(relationOne(actual.user));
      if (expected.guestPhone) {
        check(Boolean(actualUser.id), "ORDER_GUEST_USER_NOT_LINKED");
        check(
          T.canonicalPhone(actualUser.phone) === expected.guestPhone,
          "ORDER_GUEST_USER_PHONE_MISMATCH",
        );
      } else {
        check(!actualUser.id, "ORDER_UNRESOLVED_GUEST_HAS_USER");
      }
    }
    if (valid) ledger.count("orders", "verified");
  }
}

async function reconcileBlogs(source, destination, dryRun, ledger) {
  const destinationRows = (await destination.loadSnapshot("blogPosts")).map(attrs);
  const bySlug = new Map(destinationRows.map((row) => [String(row.Slug || ""), row]));
  for (const sourceId of (dryRun.candidates?.blogPosts || []).map(String)) {
    ledger.count("blogPosts", "source");
    const sourcePost = await source.getPost(sourceId);
    const expected = T.blogPostPayload(sourcePost);
    const actual = bySlug.get(expected.data.Slug);
    if (!actual) mismatch(ledger, "blogPosts", sourceId, "BLOG_POST_NOT_FOUND");
    else {
      const timestamps = wordpressSourceTimestamps(sourcePost);
      if (timestamps && (
        !sameTimestamp(actual.createdAt, timestamps.createdAt) ||
        !sameTimestamp(actual.updatedAt, timestamps.updatedAt)
      )) {
        mismatch(ledger, "blogPosts", sourceId, "BLOG_POST_SOURCE_TIMESTAMP_MISMATCH");
      } else ledger.count("blogPosts", "verified");
    }
  }
}

async function runReconcile({ source, destination, ledger, pilot, dryRun }) {
  await reconcileProducts(source, destination, dryRun, pilot, ledger);
  await reconcileUsersAndWallets(source, destination, dryRun, pilot, ledger);
  await reconcileOrders(source, destination, dryRun, pilot, ledger);
  await reconcileBlogs(source, destination, dryRun, ledger);
  if (pilot.command === "pilot") {
    ledger.summary.pilotRunId = pilot.runId;
    ledger.summary.sourceDryRunId = dryRun.runId;
  } else {
    ledger.summary.sourceFullRunId = pilot.runId;
  }
  if (pilot.acceptedExceptions) {
    ledger.summary.acceptedExceptions = {
      manifestSha256: pilot.acceptedExceptions.manifestSha256,
      count: Number(pilot.acceptedExceptions.entries?.length || 0),
      dependentOrderIds: (pilot.acceptedExceptions.dependentOrderIds || []).map(String),
    };
  }
  ledger.summary.metrics.source = source.metrics();
  ledger.summary.metrics.destination = destination.metrics();
  ledger.persist();
  return ledger.summary;
}

async function buildFullReconciliationInputs(source, fullRun, catalogRun) {
  const productIds = Object.values(catalogRun.items || {})
    .filter((item) => item.entity === "products" && item.status === "completed" && item.wcId !== undefined)
    .map((item) => String(item.wcId));
  const userIds = [];
  for await (const page of source.customers()) {
    for (const row of page.rows) userIds.push(String(row.id));
  }
  const walletIds = [];
  for await (const page of source.walletUsers()) {
    for (const row of page.rows) walletIds.push(String(row.id));
  }
  const blogPosts = [];
  for await (const page of source.posts()) {
    for (const row of page.rows) blogPosts.push(String(row.id));
  }
  const excludedOrderIds = new Set((catalogRun.acceptedExceptions?.dependentOrderIds || []).map(String));
  const orders = [];
  for await (const page of source.orders()) {
    for (const row of page.rows) {
      const sourceId = String(row.id);
      if (!excludedOrderIds.has(sourceId)) orders.push({ sourceId });
    }
  }
  return {
    pilot: {
      ...fullRun,
      acceptedExceptions: catalogRun.acceptedExceptions || null,
      pilotSelection: { productIds, userIds, walletIds, orders },
    },
    dryRun: {
      runId: fullRun.runId,
      candidates: { products: productIds, userInsert: userIds, walletZero: walletIds, blogPosts, orders },
    },
  };
}

module.exports = { runReconcile, buildFullReconciliationInputs };
