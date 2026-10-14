import { createServer, type Server } from "node:http";
import fs from "node:fs";
import ExcelJS from "exceljs";
import { setupStrapi, teardownStrapi } from "../strapiInstance";
import { makeFactories, type Factories, TEST_PREFIX } from "../factories";
import * as PA from "../../../api/report/services/product-analytics";

let app: any;
let server: Server;
let origin: string;
let factory: Factories;
let financeToken: string;
let founderToken: string;
let sellerToken: string;
let superadminToken: string;
let splitOrder: number;
let cancelledOrder: number;
let lateOrder: number;
let code: string;
let adjustmentId: number;
let topupId: number;
let inventoryProductId: number;
let inventoryVariationIds: number[];
const owned: Array<{ uid: string; id: number }> = [];
const range = "start=2026-10-01&end=2026-10-01";
const START = "2026-09-30T20:30:00.000Z";
const END = "2026-10-01T20:30:00.000Z";

async function create(uid: string, data: any) {
  const row = await app.db.query(uid).create({ data });
  owned.push({ uid, id: row.id });
  // Pin fixture instants to the repository's UTC-naive storage contract.
  // pg serializes Date objects using Node's TZ; these explicit raw UTC values
  // keep fixture creation independent from the timezone under test.
  const metadata = app.db.metadata.get(uid);
  const dates = Object.fromEntries(["Date"].filter((key) => data[key])
    .map((key) => [metadata.attributes[key].columnName, new Date(data[key]).toISOString()]));
  if (Object.keys(dates).length) await app.db.connection(metadata.tableName).where({ id: row.id }).update(dates);
  return row;
}
async function staff(type: string, name: string) {
  let role = await app.db.query("plugin::users-permissions.role").findOne({ where: { type } });
  if (!role) role = await create("plugin::users-permissions.role", { type, name, description: TEST_PREFIX });
  // Give every fixture role the transport permissions. Capability checks must
  // still deny Seller 2 even when the U&P action was mistakenly granted.
  for (const action of ["payments", "wallet", "inventoryHistory", "orders", "productBuyers"]) {
    await create("plugin::users-permissions.permission", { action: `api::report-export.report-export.${action}`, role: role.id });
  }
  const user = await factory.createUser();
  await app.db.query("plugin::users-permissions.user").update({ where: { id: user.id }, data: { role: role.id } });
  return { user, token: app.plugin("users-permissions").service("jwt").issue({ id: user.id }) };
}
async function get(path: string, token = superadminToken) {
  return fetch(`${origin}/api/reports/exports/${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
}
async function workbook(path: string, token = superadminToken) {
  const response = await get(path, token);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("spreadsheetml");
  expect(response.headers.get("cache-control")).toContain("no-store");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (process.env.REPORT_EXPORT_QA_DIR) {
    fs.mkdirSync(process.env.REPORT_EXPORT_QA_DIR, { recursive: true });
    const report = path.split("?")[0];
    fs.writeFileSync(`${process.env.REPORT_EXPORT_QA_DIR}/${report}${path.includes("kind=adjustments") ? "-adjustments" : ""}.xlsx`, buffer);
  }
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  return { response, book };
}
function table(book: ExcelJS.Workbook, requiredHeaders: string[]) {
  const sheet = book.worksheets.find((s) => {
    const headers = s.getRow(1).values as any[];
    return requiredHeaders.every((header) => headers.includes(header));
  });
  if (!sheet) throw new Error(`Missing sheet headers: ${requiredHeaders.join(", ")}; sheets=${book.worksheets.map((s) => `${s.name}:${s.getRow(1).values}`).join(";")}`);
  const headers = sheet.getRow(1).values as any[];
  const rows: Record<string, any>[] = [];
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    const out: Record<string, any> = {};
    headers.forEach((header, column) => { if (header) out[header] = row.getCell(column).value; });
    rows.push(out);
  });
  return { sheet, rows };
}
function allText(book: ExcelJS.Workbook): string {
  return book.worksheets.map((sheet) => {
    const values: any[] = [];
    sheet.eachRow((row) => row.eachCell((cell) => values.push(cell.value)));
    return JSON.stringify(values);
  }).join("\n");
}

beforeAll(async () => {
  process.env.STRAPI_ENABLE_DOCUMENTATION = "false";
  process.env.BETTER_AUTH_BRIDGE_ENABLED = "false";
  app = await setupStrapi();
  app.server.mount();
  server = createServer(app.server.app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  factory = makeFactories(app);
  PA.__resetJoinCache();
  const finance = await staff("finance", "Finance");
  financeToken = finance.token;
  founderToken = (await staff("founder", "Founder")).token;
  sellerToken = (await staff("seller-2", "Seller 2")).token;
  superadminToken = (await staff("superadmin", "Superadmin")).token;

  const buyer = await factory.createUser({ phone: "09999990001" });
  await factory.createUserInfo({ userId: buyer.id, firstName: "=HYPERLINK(\"https://invalid.example\")", lastName: "خریدار آزمایشی" });
  const product = await factory.createProduct({ title: "محصول آزمایشی گزارش" });
  const a = await factory.createVariation({ productId: product.id, stockCount: 3, price: 600 });
  const b = await factory.createVariation({ productId: product.id, stockCount: 0, price: 400 });
  inventoryProductId = product.id;
  inventoryVariationIds = [a.id, b.id];
  code = `${TEST_PREFIX}REPORT_EXPORT`;
  await app.db.connection("product_variations").whereIn("id", [a.id, b.id]).update({ sku: code });
  const wallet = await factory.createWallet({ userId: buyer.id, balanceIrr: 50000 });

  async function order(status: string, createdAt: string, amount: number, counts = [1, 1]) {
    const contract = await factory.createContract({ userId: buyer.id, amount, status: "Finished" });
    const row = await factory.createOrder({ userId: buyer.id, contractId: contract.id, status, paymentGateway: "SamanKish", reservationStatus: "Consumed" });
    await app.db.connection("orders").where({ id: row.id }).update({ date: createdAt, shipping_cost: 100, applied_discount_amount: 100 });
    for (const [index, variation] of [a, b].entries()) {
      const item = await factory.createOrderItem({ orderId: row.id, variationId: variation.id, count: counts[index], perAmount: index === 0 ? 600 : 400 });
      await app.db.connection("order_items").where({ id: item.id }).update({ product_sku: code, product_title: "نام ثبت‌شده هنگام خرید" });
    }
    return { ...row, contractId: contract.id };
  }
  async function tx(orderRow: any, amount: number, gateway: string, date: string, type = "Gateway", reference?: string, status = "Success") {
    const row = await factory.createContractTransaction({ contractId: orderRow.contractId, amount, type, status: status as any, gatewayRefId: `receipt-${amount}`, trackId: "DO_NOT_EXPORT_PAYMENT_TOKEN", externalId: reference });
    await app.db.connection("contract_transactions").where({ id: row.id }).update({ date, settlement_gateway: gateway });
    return row;
  }
  const split = await order("Done", START, 1000);
  splitOrder = split.id;
  const reference = `wallet-order-${split.id}-${split.contractId}`;
  await tx(split, 4000, "Wallet", START, "Gateway", reference);
  await tx(split, 6000, "SamanKish", START);
  await create("api::local-user-wallet-transaction.local-user-wallet-transaction", { Amount: 4000, Type: "Minus", Date: START, Cause: "Order Payment", ReferenceId: reference, user_wallet: wallet.id });

  const cancelled = await order("Cancelled", START, 1000);
  cancelledOrder = cancelled.id;
  await tx(cancelled, 10000, "SamanKish", START);
  const refundReference = `wallet-refund-order-${cancelled.id}-cancel`;
  await tx(cancelled, 10000, "Wallet", "2026-10-01T12:00:00.000Z", "Return", refundReference);
  await create("api::local-user-wallet-transaction.local-user-wallet-transaction", { Amount: 10000, Type: "Add", Date: "2026-10-01T12:00:00.000Z", Cause: "Order Cancelled (Admin)", ReferenceId: refundReference, user_wallet: wallet.id });

  const unpaid = await order("Paying", START, 1000);
  await tx(unpaid, 99990, "SamanKish", START, "Gateway", undefined, "Failed");
  const late = await order("Started", "2026-09-29T10:00:00.000Z", 1000);
  lateOrder = late.id;
  await tx(late, 10000, "SamanKish", "2026-10-01T01:00:00.000Z");
  // A snapshot remains reportable after its live variation relation disappears.
  const lateItem = await app.db.query("api::order-item.order-item").findOne({ where: { order: { id: late.id } } });
  await app.db.connection("order_items_product_variation_links").where({ order_item_id: lateItem.id }).delete();

  const outside = await order("Done", END, 1000);
  await tx(outside, 123450, "SamanKish", END);
  const adjustment = await create("api::local-user-wallet-transaction.local-user-wallet-transaction", { Amount: 3211, Type: "Add", Date: START, Cause: "Admin Wallet Adjustment", ReferenceId: `${TEST_PREFIX}adjustment`, Note: "اصلاح آزمایشی", user_wallet: wallet.id });
  adjustmentId = adjustment.id;
  await create("api::manual-admin-activity.manual-admin-activity", {
    ResourceType: "User", ResourceId: String(buyer.id), Action: "Update", Title: "اصلاح کیف پول", Message: "اصلاح آزمایشی", Metadata: { ledgerId: adjustment.id, reason: "اصلاح آزمایشی" },
    actorLabel: "کارشناس آزمایشی", PerformedByName: "کارشناس آزمایشی", occurredAt: START,
    eventKey: "wallets.adjusted", eventId: "8e6dd623-86b8-4dc3-8dfb-1be0b2ae8990", Changes: [{ field: "balance", from: 0, to: 3211 }],
  });
  const topupReference = `${TEST_PREFIX}confirmed-topup`;
  const topup = await create("api::wallet-topup.wallet-topup", {
    Amount: 7500, Gateway: "SamanKish", Status: "Success", user: buyer.id,
    SaleOrderId: `${TEST_PREFIX}topup-intent`, LedgerReferenceId: topupReference,
    VerificationReference: "verified-topup-receipt", ProviderReference: "DO_NOT_EXPORT_TOPUP_TOKEN",
    Date: "2026-09-30T20:29:00.000Z",
  });
  topupId = topup.id;
  await create("api::local-user-wallet-transaction.local-user-wallet-transaction", {
    Amount: 7500, Type: "Add", Date: "2026-09-30T20:31:00.000Z",
    Cause: "Wallet Topup", ReferenceId: topupReference, user_wallet: wallet.id,
  });
}, 240000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (app) {
    for (const row of owned.reverse()) {
      if (row.uid === "api::manual-admin-activity.manual-admin-activity") {
        // Audit events are append-only even during tests. The disposable
        // Testcontainers database is their cleanup boundary.
        continue;
      } else await app.db.query(row.uid).delete({ where: { id: row.id } });
    }
    if (factory) await factory.cleanup();
  }
  await teardownStrapi();
});

describe("self-service XLSX exports on real PostgreSQL", () => {
  it("authorizes only Superadmin and refuses other staff even with action grants", async () => {
    expect([401, 403]).toContain((await get(`payments?${range}`, "")).status);
    for (const report of ["payments", "wallet", "orders", "product-buyers", "inventory-history"]) {
      const query = report === "inventory-history" ? `productCode=${code}` : report === "product-buyers" ? `${range}&productCodes=${code}` : range;
      for (const token of [sellerToken, financeToken, founderToken]) {
        expect((await get(`${report}?${query}`, token)).status).toBe(403);
      }
    }
    await workbook(`wallet?${range}`, superadminToken);
  });

  it("includes both Tehran boundary charges and cancelled movements, excludes failed and next-day payments", async () => {
    const { book } = await workbook(`payments?${range}`);
    const text = allText(book);
    const movements = table(book, ["سفارش", "مبلغ (تومان)"]).rows;
    const ids = movements.map((row) => row["سفارش"]);
    expect(ids).toContain(String(splitOrder));
    expect(ids).toContain(String(cancelledOrder));
    expect(ids).toContain(String(lateOrder));
    expect(movements).toHaveLength(6);
    expect(text).not.toContain("DO_NOT_EXPORT_PAYMENT_TOKEN");
    expect(text).not.toContain("DO_NOT_EXPORT_TOPUP_TOKEN");
    expect(movements.map((row) => row["مبلغ (تومان)"])).not.toContain(12345);
    expect(movements.map((row) => row["مبلغ (تومان)"])).not.toContain(9999);
    for (const sheet of book.worksheets) {
      expect(sheet.views[0].rightToLeft).toBe(true);
      expect(sheet.views[0].state).toBe("frozen");
      expect(sheet.autoFilter).toBeDefined();
    }
  });

  it("dates a confirmed wallet topup by its matched credit after Tehran midnight, not its intent", async () => {
    const { book } = await workbook(`payments?${range}&transactionType=wallet-topup`);
    const rows = table(book, ["شناسه سند", "مبلغ (تومان)"]).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]["شناسه سند"]).toBe(`TOPUP:${topupId}`);
    expect(rows[0]["مبلغ (تومان)"]).toBe(750);
    expect(rows[0]["تاریخ (تهران)"]).toContain("۰۰:۰۱:۰۰");
    const previous = await workbook("payments?start=2026-09-30&end=2026-09-30&transactionType=wallet-topup");
    expect(previous.response.headers.get("x-report-row-count")).toBe("0");
  });

  it("keeps distinct paid orders separate from split attribution and wallet refunds separate from bank cash", async () => {
    const { book } = await workbook(`payments?${range}`);
    const population = table(book, ["سفارش واجد شرایط یکتا", "انتساب به درگاه"]).rows[0];
    expect(population["سفارش واجد شرایط یکتا"]).toBe(2);
    expect(population["انتساب به درگاه"]).toBe(3);
    expect(population["چندروش"]).toBe(1);
    const cash = table(book, ["خالص وجه غیرکیف پول (تومان)"]).rows;
    expect(cash.reduce((sum, row) => sum + Number(row["خالص وجه غیرکیف پول (تومان)"]), 0)).toBe(3350);
  });

  it("exports wallet staff attribution and exact rial-to-Toman fractions", async () => {
    const { book } = await workbook(`wallet?${range}&kind=adjustments`);
    const text = allText(book);
    expect(table(book, ["شناسه سند کیف پول", "کارمند"]).rows.map((row) => row["شناسه سند کیف پول"])).toContain(String(adjustmentId));
    expect(text).toContain("کارشناس آزمایشی");
    expect(text).toContain("اصلاح آزمایشی");
    expect(text).toContain("321.1");
  });

  it("shows wallet-funded orders with confirmed partial funding while preserving period ledger totals", async () => {
    const { book } = await workbook(`wallet?${range}&kind=order-payments`);
    const orders = table(book, ["برداشت کیف پول در بازه (تومان)", "نوع پرداخت"]).rows;
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ "شماره سفارش": String(splitOrder), "نوع پرداخت": "بخشی با کیف پول", "برداشت کیف پول در بازه (تومان)": 400, "پرداخت موفق کیف پول (تومان)": 400, "پرداخت موفق سایر روش‌ها (تومان)": 600 });
    expect(table(book, ["خالص تغییر (تومان)"]).rows[0]["خالص تغییر (تومان)"]).toBe(-400);
    expect((await workbook(`wallet?${range}&direction=credit`)).book.getWorksheet("سفارش‌های کیف پول")!.rowCount).toBe(1);
  });

  it("separates order totals from item rows and retains formula-like customer names as text", async () => {
    const { book } = await workbook(`orders?${range}&orderStatus=Done`);
    expect(book.worksheets.some((sheet) => sheet.name === "سفارش‌ها")).toBe(true);
    expect(book.worksheets.some((sheet) => sheet.name === "اقلام سفارش")).toBe(true);
    let found = false;
    for (const sheet of book.worksheets) sheet.eachRow((row) => row.eachCell((cell) => {
      if (typeof cell.value === "string" && cell.value.startsWith("=HYPERLINK")) {
        found = true;
        expect(cell.type).toBe(ExcelJS.ValueType.String);
      }
      expect(cell.type).not.toBe(ExcelJS.ValueType.Formula);
    }));
    expect(found).toBe(true);
    const orders = table(book, ["شماره سفارش", "مبلغ سفارش (تومان)"]).rows;
    expect(orders.map((row) => row["شماره سفارش"])).toEqual([String(splitOrder)]);
    expect(orders[0]["مبلغ سفارش (تومان)"]).toBe(1000);
    expect(orders[0]["ارسال (تومان)"]).toBe(100);
    expect(orders[0]["تخفیف (تومان)"]).toBe(100);
    const items = table(book, ["شناسه قلم", "مبلغ قلم (تومان)"]);
    expect(items.rows).toHaveLength(2);
    expect(items.rows.reduce((sum, row) => sum + Number(row["مبلغ قلم (تومان)"]), 0)).toBe(1000);
    expect(items.sheet.getRow(1).values).not.toContain("مبلغ سفارش (تومان)");
  });

  it("matches paid buyer snapshots including detached variations without treating unpaid or cancelled orders as sales", async () => {
    const { book } = await workbook(`product-buyers?${range}&productCodes=${code},${code}`);
    const text = allText(book);
    const buyers = table(book, ["کد محصول", "شماره سفارش"]).rows;
    const ids = buyers.map((row) => row["شماره سفارش"]);
    expect(ids).toContain(String(splitOrder));
    expect(ids).toContain(String(lateOrder));
    expect(ids).not.toContain(String(cancelledOrder));
    expect(buyers).toHaveLength(4);
    expect(text).toContain("نام ثبت‌شده هنگام خرید");
  });

  it("exports current inventory while marking unreliable history rather than inventing movements", async () => {
    const { book } = await workbook(`inventory-history?productCode=${code}`);
    const text = allText(book);
    expect(text).toContain("محصول آزمایشی گزارش");
    expect(text).toMatch(/نامشخص|ناقص|کامل نیست/);
  });

  it("resolves former inventory codes after a rename and on a retained purged tombstone", async () => {
    try {
      await app.db.connection("product_variations").whereIn("id", inventoryVariationIds).update({ sku: `${code}_RENAMED` });
      const renamed = await workbook(`inventory-history?productCode=${code}`);
      expect(table(renamed.book, ["شناسه محصول", "موجودی فعلی"]).rows[0]["شناسه محصول"]).toBe(String(inventoryProductId));
      await app.db.connection("product_variations").whereIn("id", inventoryVariationIds).update({ sku: `${code}~purged-${inventoryProductId}` });
      await app.db.connection("products").where({ id: inventoryProductId }).update({ purged_at: "2026-10-02T00:00:00.000Z" });
      const purged = await workbook(`inventory-history?productCode=${code}`);
      expect(table(purged.book, ["شماره سفارش", "شناسه تنوع"]).rows.map((row) => row["شماره سفارش"])).toContain(String(splitOrder));
    } finally {
      await app.db.connection("products").where({ id: inventoryProductId }).update({ purged_at: null });
      await app.db.connection("product_variations").whereIn("id", inventoryVariationIds).update({ sku: code });
    }
  });

  it("rejects a reused code that identifies two products instead of attributing old orders to the new product", async () => {
    const other = await factory.createProduct({ title: "محصول دیگری با کد قدیمی" });
    const variation = await factory.createVariation({ productId: other.id, stockCount: 7, price: 100 });
    try {
      await app.db.connection("product_variations").whereIn("id", inventoryVariationIds).update({ sku: `${code}_RENAMED` });
      await app.db.connection("product_variations").where({ id: variation.id }).update({ sku: code });
      const response = await get(`inventory-history?productCode=${code}`);
      expect(response.status).toBe(409);
      expect((await response.json()).error.details.code).toBe("AMBIGUOUS_PRODUCT_CODE");
    } finally {
      await app.db.connection("product_variations").where({ id: variation.id }).update({ sku: `${code}_OTHER` });
      await app.db.connection("product_variations").whereIn("id", inventoryVariationIds).update({ sku: code });
    }
  });

  it("exports detached historical inventory order facts with unknown balances", async () => {
    const links = await app.db.connection("order_items_product_variation_links").whereIn("product_variation_id", inventoryVariationIds).select("*");
    try {
      await app.db.connection("product_variations").whereIn("id", inventoryVariationIds).update({ sku: `${code}_RENAMED` });
      await app.db.connection("order_items_product_variation_links").whereIn("product_variation_id", inventoryVariationIds).delete();
      const { book } = await workbook(`inventory-history?productCode=${code}`);
      expect(table(book, ["شناسه محصول", "موجودی فعلی"]).rows[0]).toMatchObject({ "شناسه محصول": "نامشخص", "موجودی فعلی": "نامشخص", "رزروشده": "نامشخص", "قابل فروش": "نامشخص" });
      expect(table(book, ["شماره سفارش", "شناسه تنوع"]).rows).toHaveLength(10);
      expect(allText(book)).toContain("نام ثبت‌شده هنگام خرید");
    } finally {
      if (links.length) await app.db.connection("order_items_product_variation_links").insert(links);
      await app.db.connection("product_variations").whereIn("id", inventoryVariationIds).update({ sku: code });
    }
  });

  it("returns a useful empty XLSX and rejects invalid, unknown, reversed and pre-cutover filters", async () => {
    const { response, book } = await workbook(`orders?start=2026-10-03&end=2026-10-03`);
    expect(response.headers.get("x-report-row-count")).toBe("0");
    expect(book.worksheets.length).toBeGreaterThan(1);
    for (const query of ["start=2026-02-31&end=2026-10-01", "start=2026-10-02&end=2026-10-01", "start=2026-09-13&end=2026-10-01", `${range}&privateField=password`]) {
      expect((await get(`orders?${query}`)).status).toBe(400);
    }
  });

  it("includes the final PostgreSQL microsecond of a Tehran day in buyers and dashboard reconciliation", async () => {
    const contract = await factory.createContract({ amount: 100, status: "Finished" });
    const order = await factory.createOrder({ contractId: contract.id, status: "Done", paymentGateway: "SamanKish" });
    await app.db.connection("orders").where({ id: order.id }).update({ date: START });
    const item = await factory.createOrderItem({ orderId: order.id, variationId: inventoryVariationIds[0], count: 1, perAmount: 100 });
    await app.db.connection("order_items").where({ id: item.id }).update({ product_sku: code });
    const transaction = await factory.createContractTransaction({ contractId: contract.id, amount: 1000, status: "Success", type: "Gateway" });
    await app.db.connection("contract_transactions").where({ id: transaction.id }).update({ date: "2026-10-01T20:29:59.999999Z", settlement_gateway: "SamanKish" });
    const last = await workbook(`product-buyers?${range}&productCodes=${code}`);
    expect(table(last.book, ["کد محصول", "شماره سفارش"]).rows.map((row) => row["شماره سفارش"])).toContain(String(order.id));
    const payments = await workbook(`payments?${range}`);
    expect(table(payments.book, ["سفارش واجد شرایط یکتا", "انتساب به درگاه"]).rows[0]).toMatchObject({ "سفارش واجد شرایط یکتا": 3, "انتساب به درگاه": 4 });
    await app.db.connection("contract_transactions").where({ id: transaction.id }).update({ date: END });
    const nextDay = await workbook(`product-buyers?${range}&productCodes=${code}`);
    expect(table(nextDay.book, ["کد محصول", "شماره سفارش"]).rows.map((row) => row["شماره سفارش"])).not.toContain(String(order.id));
  });
});
