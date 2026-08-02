"use strict";

const CatalogT = require("../catalog/lib/transforms");
const T = require("./lib/transforms");

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

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

async function reconcileProducts(source, destination, dryRun, pilot, ledger) {
  const productIds = selectedIds(dryRun, pilot, "productIds");
  for (const sourceId of productIds) {
    ledger.count("products", "source");
    const sourceProduct = await source.getProduct(sourceId);
    const destinationResponse = await destination.getContent("/products", {
      "filters[external_source][$eq]": "woocommerce",
      "filters[external_id][$eq]": sourceId,
      "populate[product_size_helper]": "true",
      "populate[product_attribute_assignments][populate][product_attribute]": "true",
      "pagination[pageSize]": 2,
    });
    const rows = rowsOf(destinationResponse);
    if (rows.length !== 1) {
      mismatch(ledger, "products", sourceId, "PRODUCT_NOT_UNIQUE");
      continue;
    }
    const destinationProduct = attrs(rows[0]);
    const expectedGuide = CatalogT.extractSizeGuideMatrix(sourceProduct);
    const helper = attrs(destinationProduct.product_size_helper?.data || destinationProduct.product_size_helper);
    const actualGuide = helper?.Helper ?? null;
    if (destinationProduct.Title !== sourceProduct.name) mismatch(ledger, "products", sourceId, "PRODUCT_TITLE_MISMATCH");
    if (destinationProduct.Slug !== safeDecode(sourceProduct.slug)) mismatch(ledger, "products", sourceId, "PRODUCT_SLUG_MISMATCH");
    if (JSON.stringify(expectedGuide) !== JSON.stringify(actualGuide)) {
      mismatch(ledger, "products", sourceId, "SIZE_GUIDE_MISMATCH");
      continue;
    }
    ledger.count("products", "verified");
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
    else if (T.canonicalPhone(actual.phone) !== expected.phone) mismatch(ledger, "users", sourceId, "USER_PHONE_MISMATCH");
    else ledger.count("users", "verified");
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
      "populate[delivery_address]": "true",
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
    check(String(actual.ShippingCost || 0) === expected.shippingRial, "ORDER_SHIPPING_MISMATCH");
    check(actual.PaymentGateway === expected.paymentGateway, "ORDER_PAYMENT_GATEWAY_MISMATCH");
    check(!relationOne(actual.delivery_address), "ORDER_ADDRESS_PRESENT");
    check(actual.Description == null && actual.Note == null, "ORDER_PRIVATE_TEXT_PRESENT");
    check(contract.Status === expected.contractStatus, "ORDER_CONTRACT_STATUS_MISMATCH");
    check(String(contract.Amount) === expected.totalRial, "ORDER_TOTAL_MISMATCH");
    check(actualItems.length === expected.items.length, "ORDER_ITEM_COUNT_MISMATCH");
    for (const expectedItem of expected.items) {
      const actualItem = itemsBySource.get(`line_item_${expectedItem.sourceId}`);
      if (!actualItem) {
        check(false, "ORDER_ITEM_NOT_FOUND");
        continue;
      }
      const actualVariation = attrs(relationOne(actualItem.product_variation));
      check(Number(actualItem.Count) === expectedItem.count, "ORDER_ITEM_QUANTITY_MISMATCH");
      check(String(actualItem.PerAmount) === expectedItem.unitPriceRial, "ORDER_ITEM_PRICE_MISMATCH");
      check(String(actualVariation.external_id || "") === expectedItem.variationSourceId, "ORDER_ITEM_VARIATION_MISMATCH");
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
      check(!actualUser.id || actualUser.external_source === "wordpress", "ORDER_GUEST_USER_UNAPPROVED");
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
    if (!bySlug.has(expected.data.Slug)) mismatch(ledger, "blogPosts", sourceId, "BLOG_POST_NOT_FOUND");
    else ledger.count("blogPosts", "verified");
  }
}

async function runReconcile({ source, destination, ledger, pilot, dryRun }) {
  await reconcileProducts(source, destination, dryRun, pilot, ledger);
  await reconcileUsersAndWallets(source, destination, dryRun, pilot, ledger);
  await reconcileOrders(source, destination, dryRun, pilot, ledger);
  await reconcileBlogs(source, destination, dryRun, ledger);
  ledger.summary.pilotRunId = pilot.runId;
  ledger.summary.sourceDryRunId = dryRun.runId;
  ledger.summary.metrics.source = source.metrics();
  ledger.summary.metrics.destination = destination.metrics();
  ledger.persist();
  return ledger.summary;
}

module.exports = { runReconcile };
