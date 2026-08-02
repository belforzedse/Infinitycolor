"use strict";

const CatalogT = require("../catalog/lib/transforms");
const T = require("./lib/transforms");

function rowsOf(response) {
  return Array.isArray(response?.data) ? response.data : [];
}

function attrs(row) {
  return row?.attributes || row || {};
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

async function reconcileProducts(source, destination, dryRun, ledger) {
  const productIds = Array.isArray(dryRun?.candidates?.products) ? dryRun.candidates.products : [];
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

async function reconcileUsersAndWallets(source, destination, dryRun, ledger) {
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
  const userIds = Array.from(new Set([
    ...(dryRun.candidates?.userInsert || []),
    ...(dryRun.candidates?.walletZero || []),
    ...(dryRun.candidates?.walletNonZero || []),
  ])).map(String);
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
  for (const sourceId of Array.from(new Set([
    ...(dryRun.candidates?.walletZero || []),
    ...(dryRun.candidates?.walletNonZero || []),
  ])).map(String)) {
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

async function reconcileOrders(source, destination, dryRun, ledger) {
  const destinationRows = (await destination.loadSnapshot("orders")).map(attrs);
  const bySource = new Map(
    destinationRows
      .filter((row) => row.external_source === "woocommerce")
      .map((row) => [String(row.external_id || ""), row]),
  );
  for (const sourceId of (dryRun.candidates?.orders || []).map(String)) {
    ledger.count("orders", "source");
    if (!bySource.has(sourceId)) mismatch(ledger, "orders", sourceId, "ORDER_NOT_FOUND");
    else ledger.count("orders", "verified");
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
  await reconcileProducts(source, destination, dryRun, ledger);
  await reconcileUsersAndWallets(source, destination, dryRun, ledger);
  await reconcileOrders(source, destination, dryRun, ledger);
  await reconcileBlogs(source, destination, dryRun, ledger);
  ledger.summary.pilotRunId = pilot.runId;
  ledger.summary.sourceDryRunId = dryRun.runId;
  ledger.summary.metrics.source = source.metrics();
  ledger.summary.metrics.destination = destination.metrics();
  ledger.persist();
  return ledger.summary;
}

module.exports = { runReconcile };
