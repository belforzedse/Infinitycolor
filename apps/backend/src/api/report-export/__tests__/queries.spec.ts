import * as Q from "../lib/queries";
import { parseExportFilters } from "../lib/filters";

import { joins } from "./fixtures";
describe("export source contracts", () => {
  it("reads successful money evidence, never attempts or token fields, and bounds returned movement rows", () => {
    const query = Q.paymentsQuery(joins, parseExportFilters("payments", { start: "2026-09-14", end: "2026-09-15", provider: "Wallet", orderStatus: "Cancelled" }));
    expect(query.sql).toContain("ct.status = 'Success'"); expect(query.sql).toContain("tu.status = 'Success'");
    expect(query.sql).not.toMatch(/track_id|gateway_authority|payment_attempts|tu\.provider_reference/i);
    expect(query.sql).not.toContain("o.status IN"); expect(query.sql).toContain("LIMIT 25001");
    expect(query.bindings.slice(-2)).toEqual(["Wallet", "Cancelled"]);
    expect(query.sql).toContain("cm.wallet_reference = wt.reference_id");
    expect(query.sql).not.toMatch(/abs\(.*date|interval '.*second/i);
  });
  it("matches historical buyer SKUs without a live variation/product relation", () => {
    const query = Q.productBuyersQuery(joins, parseExportFilters("product-buyers", { start: "2026-09-14", end: "2026-09-15", productCodes: "N-00119" }));
    expect(query.sql).toContain("infinity_order_sku(oi.product_sku) IN (?)");
    expect(query.sql).not.toMatch(/(?<!LEFT )JOIN product_variations/); expect(query.sql).toContain("'Started', 'Shipment', 'Done'");
    expect(query.sql).toContain("recorded_color.title AS color");
    expect(query.sql).toContain("ct.status = 'Success'"); expect(query.sql).toContain("ct.date BETWEEN ? AND (?::timestamp - INTERVAL '1 microsecond')");
  });
  it("reads complete wallet ledger and uses an exact adjustment id link", () => {
    const query = Q.walletQuery(joins, parseExportFilters("wallet", { start: "2026-09-14", end: "2026-09-15" }));
    expect(query.sql).toContain("FROM local_user_wallet_transactions wt");
    expect(query.sql).toContain("m.metadata ->> 'ledgerId' = wt.id::text");
    expect(query.sql).not.toContain("wt.type = ?"); expect(query.sql).not.toContain("m.ip");
    expect(query.sql).toContain("LEFT JOIN users u"); expect(query.sql).not.toContain("up_users");
  });
  it("filters orders on their own date and includes successful split-payment providers", () => {
    const query = Q.ordersQuery(joins, parseExportFilters("orders", { start: "2026-09-14", end: "2026-09-15", provider: "Wallet" }));
    expect(query.sql).toContain("o.date >= ?"); expect(query.sql).toContain("o.date < ?");
    expect(query.sql).toContain("ct.settlement_gateway"); expect(query.sql).toContain("FROM orders money_order");
    expect(query.sql).not.toContain("paid_orders");
  });
  it("uses movement filters to select split orders but shows full lifetime funding", () => {
    const query = Q.splitPaymentsQuery(joins, parseExportFilters("payments", { start: "2026-09-14", end: "2026-09-15", provider: "Wallet" }));
    expect(query.bindings.at(-1)).toBe("Wallet"); expect(query.sql).toContain("selected_orders AS (SELECT DISTINCT order_id FROM selected_movements");
    const funding = query.sql.split("funding AS (")[1].split("split_orders AS (")[0];
    expect(funding).toContain("ct.status = 'Success'"); expect(funding).not.toContain("ct.date >=");
    expect(query.sql).toContain("wallet_charges_irr"); expect(query.sql).toContain("other_charges_irr");
  });
  it("resolves former inventory codes through surviving identity links and refuses contradictory SKU matches", () => {
    const identities = Q.inventoryProductCandidatesQuery(joins, "OLD");
    expect(identities.sql).toContain("UNION");
    expect(identities.sql).toContain("infinity_order_sku(oi.product_sku) = ?");
    expect(identities.bindings).toEqual(["OLD", "OLD"]);
    expect(Q.inventoryOrdersQuery(joins, "1", ["OLD"]).sql).toContain("OR (p.id IS NULL AND infinity_order_sku(oi.product_sku)");
  });
});
