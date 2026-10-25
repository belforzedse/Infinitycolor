/** Disposable full-stack lab. No gateway, auth-provider or production data access. */
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";

const backendDir = path.resolve(process.cwd(), "../backend");
const requireBackend = createRequire(path.join(backendDir, "package.json"));
const FRONTEND = "http://127.0.0.1:4350";
const API = "http://127.0.0.1:4351";
const FIXTURE = "http://127.0.0.1:4352";
const METHODS = ["bpPayRequest", "bpVerifyRequest", "bpSettleRequest", "bpInquiryRequest", "bpReversalRequest"];

for (const port of [4350, 4351, 4352]) {
  await new Promise<void>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", () => reject(new Error(`Mellat lab requires free loopback port ${port}`)));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
  });
}
const { PostgreSqlContainer } = requireBackend("@testcontainers/postgresql");
const { GenericContainer } = requireBackend("testcontainers");
let postgres: any;
let redis: any;
let strapi: any;
let closing = false;
const sessions = new Map<number, any>();
const bank = new Map<string, any>();
const bodyText = (request: http.IncomingMessage) => new Promise<string>((resolve, reject) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => resolve(body));
  request.on("error", reject);
});
const xml = (value: unknown) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const field = (body: string, name: string) => body.match(new RegExp(`<(?:[^:<>]+:)?${name}(?: [^>]*)?>([^<]*)</`))?.[1] || "";
const wsdl = () => `<?xml version="1.0"?><definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:tns="urn:mellat-lab" xmlns:xsd="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:mellat-lab">
<types><xsd:schema targetNamespace="urn:mellat-lab" elementFormDefault="qualified">${METHODS.map((method) => `<xsd:element name="${method}"><xsd:complexType><xsd:sequence>${["terminalId", "userName", "userPassword", "orderId", "amount", "localDate", "localTime", "callBackUrl", "payerId", "additionalData", "saleOrderId", "saleReferenceId"].map((name) => `<xsd:element name="${name}" type="xsd:string" minOccurs="0"/>`).join("")}</xsd:sequence></xsd:complexType></xsd:element><xsd:element name="${method}Response"><xsd:complexType><xsd:sequence><xsd:element name="return" type="xsd:string"/></xsd:sequence></xsd:complexType></xsd:element>`).join("")}</xsd:schema></types>
${METHODS.map((method) => `<message name="${method}Request"><part name="parameters" element="tns:${method}"/></message><message name="${method}Response"><part name="parameters" element="tns:${method}Response"/></message>`).join("")}
<portType name="PaymentPortType">${METHODS.map((method) => `<operation name="${method}"><input message="tns:${method}Request"/><output message="tns:${method}Response"/></operation>`).join("")}</portType><binding name="PaymentBinding" type="tns:PaymentPortType"><soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>${METHODS.map((method) => `<operation name="${method}"><soap:operation soapAction="urn:${method}"/><input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation>`).join("")}</binding><service name="PaymentService"><port name="PaymentPort" binding="tns:PaymentBinding"><soap:address location="${FIXTURE}/soap"/></port></service></definitions>`;

async function snapshot(userId: number) {
  const session = sessions.get(userId);
  if (!session) throw new Error("Unknown local fixture user");
  const attempt = await strapi.db.query("api::payment-attempt.payment-attempt").findOne({
    where: { user: { id: userId }, Gateway: "mellat" }, orderBy: { id: "desc" },
    populate: { order: true, contract: true },
  });
  const wallet = await strapi.db.query("api::local-user-wallet.local-user-wallet").findOne({ where: { id: session.walletId } });
  const stock = await strapi.db.query("api::product-stock.product-stock").findOne({ where: { id: session.stockId } });
  const legs = attempt?.contract ? await strapi.db.query("api::contract-transaction.contract-transaction").findMany({
    where: { contract: { id: attempt.contract.id }, Status: "Success" },
  }) : [];
  const receipt = attempt ? [...bank.values()].find((entry) => entry.orderId === String(attempt.order.id)) : undefined;
  return {
    attemptId: attempt?.id, status: attempt?.Status, orderId: attempt?.order?.id,
    orderStatus: attempt?.order?.Status, reservationStatus: attempt?.order?.ReservationStatus,
    state: attempt?.providerResponse?.mellat, walletHoldStatus: attempt?.WalletHoldStatus,
    walletBalanceIrr: Number(wallet.Balance), walletHeldIrr: Number(wallet.HeldBalance),
    stockCount: Number(stock.Count), stockReserved: Number(stock.reservedCount),
    legs: legs.map((leg: any) => ({ gateway: leg.SettlementGateway, amountIrr: Number(leg.Amount), reference: leg.external_id })),
    receipt,
  };
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", FIXTURE);
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
    };
    if (url.pathname === "/soap") {
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "text/xml" }); response.end(wsdl()); return;
      }
      const body = await bodyText(request);
      const method = METHODS.find((name) => body.includes(`${name}>`) || body.includes(`${name} `));
      if (!method) { json({ error: "Unknown SOAP operation" }, 400); return; }
      const orderId = field(body, "orderId");
      let entry = [...bank.values()].find((item) => item.orderId === orderId);
      if (method === "bpPayRequest") {
        const order = await strapi.db.query("api::order.order").findOne({ where: { id: Number(orderId) }, populate: { user: true } });
        const session = sessions.get(Number(order.user.id));
        if (!session || field(body, "callBackUrl") !== `${API}/api/orders/payment-callback`) throw new Error("Non-local bank request refused");
        entry = { orderId, refId: `LoCaLRef${orderId}`, saleReferenceId: `${900000000000000000n + BigInt(orderId)}`,
          amountIrr: Number(field(body, "amount")), callbackUrl: field(body, "callBackUrl"),
          calls: [], mode: session.mode, settled: false };
        bank.set(entry.refId, entry);
      }
      if (!entry) throw new Error("Unknown local bank order");
      entry.calls.push(method);
      if (method !== "bpPayRequest" && field(body, "saleReferenceId") !== entry.saleReferenceId) throw new Error("Bank reference mismatch");
      if (method === "bpSettleRequest") {
        entry.settled = true;
        if (entry.mode === "timeout" && entry.calls.filter((name: string) => name === method).length === 1) return;
      }
      const code = method === "bpPayRequest" ? `0,${entry.refId}` : method === "bpInquiryRequest" && entry.settled ? "45" : method === "bpReversalRequest" ? "48" : "0";
      response.writeHead(200, { "content-type": "text/xml" });
      response.end(`<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method}Response xmlns="urn:mellat-lab"><return>${code}</return></${method}Response></soap:Body></soap:Envelope>`);
      return;
    }
    if (url.pathname === "/__lab/health") { json({ ready: Boolean(strapi?.isLoaded) }); return; }
    if (url.pathname === "/__lab/seed" && request.method === "POST") {
      const { mode = "normal", wallet = false } = JSON.parse(await bodyText(request));
      const { makeFactories } = requireBackend(path.join(process.cwd(), "test-results/mellat-factories.cjs"));
      const f = makeFactories(strapi);
      const user = await f.createUser();
      const role = await strapi.db.query("plugin::users-permissions.role").findOne({ where: { type: "authenticated" } });
      await strapi.db.query("plugin::users-permissions.user").update({ where: { id: user.id }, data: {
        role: role.id, IsVerified: true, ClaimedAt: new Date(), ProfileCompletedAt: new Date(),
      } });
      await f.createUserInfo({ userId: user.id, firstName: "مریم", lastName: "آزمایشی" });
      const customerWallet = await f.createWallet({ userId: user.id, balanceIrr: wallet ? 3_500_000 : 0 });
      const product = await f.createProduct({ status: "Active", title: "لباس آزمایشی ملت" });
      const variation = await f.createVariation({ productId: product.id, price: 1_200_000, stockCount: 5 });
      const cart = await f.createCart({ userId: user.id });
      await f.createCartItem({ cartId: cart.id, variationId: variation.id, count: 1, price: 1_200_000 });
      const province = await f.createShippingProvince({ title: "گلستان" });
      const city = await f.createShippingCity({ title: "گرگان", provinceId: province.id });
      const address = await f.createAddress({ userId: user.id, cityId: city.id, fullName: "مریم آزمایشی", phone: user.phone, postalCode: "1234567890" });
      await strapi.db.query("api::local-user-address.local-user-address").update({
        where: { id: address.id }, data: { FullAddress: "خیابان آزمایشی، پلاک ۱" },
      });
      sessions.set(user.id, { mode, walletId: customerWallet.id, stockId: variation.stockId });
      json({ userId: user.id }); return;
    }
    const userId = Number(url.searchParams.get("userId"));
    if (url.pathname === "/__lab/token") {
      if (!sessions.has(userId)) throw new Error("Unknown local user");
      json({ token: strapi.plugin("users-permissions").service("jwt").issue({ id: userId }, { expiresIn: "60s" }) }); return;
    }
    if (url.pathname === "/__lab/state") { json(await snapshot(userId)); return; }
    if (url.pathname === "/__lab/process" && request.method === "POST") {
      const state = await snapshot(userId);
      const { processMellatAttempt } = requireBackend("./dist/src/api/payment-gateway/services/mellat-coordinator.js");
      await processMellatAttempt(strapi, state.attemptId);
      json(await snapshot(userId)); return;
    }
    if (url.pathname === "/bank") {
      const entry = bank.get(url.searchParams.get("RefId") || "");
      if (!entry) throw new Error("Unknown bank handoff");
      const fields = { RefId: entry.refId, OrderId: entry.orderId, SaleOrderId: entry.orderId, SaleReferenceId: entry.saleReferenceId, ResCode: "0" };
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html lang="fa" dir="rtl"><body><h1>درگاه آزمایشی محلی ملت</h1><form method="POST" action="${xml(entry.callbackUrl)}">${Object.entries(fields).map(([key, value]) => `<input type="hidden" name="${key}" value="${xml(value)}">`).join("")}<button>بازگشت به فروشگاه</button></form></body></html>`); return;
    }
    json({ error: "Not found" }, 404);
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

async function stop(exitCode = 0) {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  server.close();
  await strapi?.destroy().catch(() => undefined);
  await Promise.all([postgres?.stop(), redis?.stop()]);
  process.exit(exitCode);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
try {
  postgres = await new PostgreSqlContainer("postgres:16-alpine").withDatabase("mellat_browser_test").withUsername("mellat_test").withPassword("mellat_test").start();
  redis = await new GenericContainer("redis:7-alpine").withExposedPorts(6379).start();
  const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
  Object.assign(process.env, {
    NODE_ENV: "test", HOST: "127.0.0.1", PORT: "4351", URL: API, FRONTEND_URL: FRONTEND,
    ADMIN_URL: "http://localhost:2891", DATABASE_CLIENT: "postgres", DATABASE_HOST: postgres.getHost(),
    DATABASE_PORT: String(postgres.getPort()), DATABASE_NAME: postgres.getDatabase(),
    DATABASE_USERNAME: postgres.getUsername(), DATABASE_PASSWORD: postgres.getPassword(), DATABASE_SSL: "false",
    DATABASE_POOL_MIN: "0", DATABASE_POOL_MAX: "5", DATABASE_SCHEMA: "public",
    REDIS_URL: redisUrl, REDIS_PASSWORD: "", QUEUE_REDIS_URL: redisUrl, QUEUE_REDIS_PASSWORD: "",
    APP_KEYS: "mellat-test-a,mellat-test-b", API_TOKEN_SALT: "mellat-test", ADMIN_JWT_SECRET: "mellat-test",
    TRANSFER_TOKEN_SALT: "mellat-test", JWT_SECRET: "mellat-test", DISABLE_BACKGROUND_JOBS: "true", SKIP_BOOTSTRAP_SEED: "true",
    SMS_ENABLED: "false", SENTRY_DSN: "", STRAPI_TELEMETRY_DISABLED: "true", STRAPI_HIDE_STARTUP_MESSAGE: "true",
    BETTER_AUTH_BRIDGE_ENABLED: "false", SNAPPAY_HARDENED_INITIATION_ENABLED: "false",
    MELLAT_CHECKOUT_MODE: "live", MELLAT_TERMINAL_ID: "1234567",
    MELLAT_USERNAME: "local-merchant", MELLAT_PASSWORD: "local-inert-password", MELLAT_GATEWAY_URL: `${FIXTURE}/soap?wsdl`,
    WALLET_HOLDS_ENABLED: "true", WALLET_CHECKOUT_SPLIT_ENABLED: "true", QUEUE_PREFIX: "mellat-browser-test",
    REVALIDATION_SECRET: "", FRONTEND_REVALIDATION_URL: `${FRONTEND}/api/revalidate`,
  });
  delete process.env.DATABASE_URL;
  const strapiFactory = requireBackend("@strapi/strapi");
  const { distDir } = await strapiFactory.compile({ appDir: backendDir, ignoreDiagnostics: false });
  strapi = strapiFactory({ appDir: backendDir, distDir, autoReload: false, serveAdminPanel: false });
  await strapi.load();
  // The normal app seed is deliberately disabled. Install only the local shopper/read permissions.
  const readActions = [
    "api::product-category.product-category.find", "api::product-category.product-category.findOne",
    "api::product.product.find", "api::product.product.findOne",
    "api::shipping-province.shipping-province.find", "api::shipping-city.shipping-city.find",
    "api::site-identity.site-identity.find", "api::site-faq.site-faq.find",
  ];
  const shopperActions = [...readActions,
    "api::auth.auth.self", "api::cart.cart.getMyCart", "api::cart.cart.checkStock",
    "api::cart.cart.checkoutQuote", "api::cart.cart.finalizeToOrder", "api::cart.cart.shippingOptions",
    "api::payment-gateway.payment-gateway.availableGateways",
    "api::payment-gateway.payment-gateway.snappEligible",
    "api::local-user-wallet.local-user-wallet.getCurrentUserWallet",
    "api::local-user-address.local-user-address.getMyAddresses",
    "api::order.order.findOne", "api::order.order.find", "api::order.order.checkPaymentStatus",
    "api::order.order.getMyOrderDetail", "api::order.order.getMyOrders", "api::order.order.reconcilePayment",
  ];
  for (const [type, actions] of [["public", readActions], ["authenticated", shopperActions]] as const) {
    const role = await strapi.db.query("plugin::users-permissions.role").findOne({ where: { type } });
    for (const action of actions) await strapi.db.query("plugin::users-permissions.permission").create({ data: { action, role: role.id } });
  }
  await strapi.server.mount();
  await new Promise<void>((resolve) => strapi.server.listen(4351, "127.0.0.1", resolve));
  await strapi.db.query("api::payment-gateway.payment-gateway").create({ data: { Title: "Mellat", IsActive: true } });
  await strapi.db.query("api::payment-gateway.payment-gateway").create({ data: { Title: "Wallet", IsActive: true } });
  await strapi.db.query("api::shipping.shipping").create({ data: { Title: "ارسال آزمایشی", Code: "mellat-lab", IsActive: true, Price: 0 } });
  await new Promise<void>((resolve) => server.listen(4352, "127.0.0.1", resolve));
  console.log("Mellat lab ready on loopback; PostgreSQL and Redis are disposable");
} catch (error) {
  console.error(error);
  await stop(1);
}
