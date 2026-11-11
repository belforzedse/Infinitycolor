import { createServer, type Server } from "node:http";
import { setupStrapi, teardownStrapi } from "../../../__tests__/integration/strapiInstance";
import { makeFactories, type Factories, TEST_PREFIX } from "../../../__tests__/integration/factories";
import { withIssuedSnappayToken } from "../../payment-gateway/services/snappay-generation";
import {
  linkBaleCheckoutOrder,
  loadBaleCheckoutCart,
  lockOwnedBaleCheckout,
  readBaleCheckoutForAttempt,
  readBaleCheckoutForOrder,
  readOwnedBaleCheckout,
} from "../services/handoff";

const BOT_TOKEN = "local-integration-bale-credential";
const CHAT_REF = "opaque-integration-chat";
let app: any;
let server: Server;
let origin: string;
let factories: Factories;
let roleId: number;
let permissionId: number | undefined;
let redis: { isReady: boolean; eval: jest.Mock };
const checkoutIds = new Set<string>();

async function call(path: string, options: {
  token?: string;
  chat?: string;
  key?: string;
  body?: object;
} = {}) {
  const response = await fetch(`${origin}/api${path}`, {
    method: options.body ? "POST" : "GET",
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.chat ? { "X-Bale-Chat-Ref": options.chat } : {}),
      ...(options.key ? { "Idempotency-Key": options.key } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json();
  if (body.checkoutUrl) checkoutIds.add(body.checkoutId);
  return { response, body };
}

function create(key: string, items: Array<{ variationId: number; quantity: number }>) {
  return call("/bale/v1/checkouts", { token: BOT_TOKEN, chat: CHAT_REF, key, body: { items } });
}

function status(checkoutId: string, chat = CHAT_REF) {
  return call(`/bale/v1/checkouts/${checkoutId}`, { token: BOT_TOKEN, chat });
}

async function customer() {
  const user = await factories.createUser();
  await app.db.query("plugin::users-permissions.user").update({
    where: { id: user.id }, data: { role: roleId },
  });
  await factories.createUserInfo({ userId: user.id });
  return { id: user.id, token: app.plugin("users-permissions").service("jwt").issue({ id: user.id }) };
}

beforeAll(async () => {
  process.env.STRAPI_ENABLE_DOCUMENTATION = "false";
  process.env.BETTER_AUTH_BRIDGE_ENABLED = "false";
  process.env.BALE_BOT_API_TOKEN = BOT_TOKEN;
  process.env.BALE_CHECKOUT_GRANT_SECRET = "throwaway-test-grant-key-with-at-least-32-bytes";
  process.env.BALE_BOT_USERNAME = "Integration_bot";
  process.env.FRONTEND_BASE_URL = "https://storefront.test.invalid";
  app = await setupStrapi();
  const role = await app.db.query("plugin::users-permissions.role").findOne({ where: { type: "authenticated" } });
  roleId = role.id;
  const permission = app.db.query("plugin::users-permissions.permission");
  const cartAccess = { role: roleId, action: "api::cart.cart.getMyCart" };
  if (!(await permission.findOne({ where: cartAccess }))) {
    permissionId = (await permission.create({ data: cartAccess })).id;
  }
  app.server.mount();
  server = createServer(app.server.app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  redis = await require(`${process.env.INTEGRATION_DIST_DIR}/src/index`).RedisClient;
  redis.isReady = true;
  redis.eval = jest.fn();
});

beforeEach(() => {
  factories = makeFactories(app);
  delete process.env.BALE_CHECKOUT_NEW_ENABLED;
  redis.eval.mockResolvedValue([1, 0]);
});

afterEach(async () => {
  if (checkoutIds.size) {
    await app.db.connection("bale_checkouts").whereIn("checkout_id", [...checkoutIds]).delete();
    checkoutIds.clear();
  }
  await factories.cleanup();
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  if (permissionId) {
    await app.db.query("plugin::users-permissions.permission").delete({ where: { id: permissionId } });
  }
  await teardownStrapi();
});

it("requires the dedicated bearer, rate limits, and reads only public inventory net of holds", async () => {
  const product = await factories.createProduct({ status: "Active" });
  const draft = await factories.createProduct({ status: "InActive" });
  const live = await factories.createVariation({
    productId: product.id, price: 149000, discountPrice: 130000, stockCount: 5, stockReserved: 3,
  });
  const labels = { color: "قرمز", size: "متوسط", model: "مدل یک" };
  const relations: Record<string, number> = {};
  for (const [kind, title] of Object.entries(labels)) {
    const uid = `api::product-variation-${kind}.product-variation-${kind}`;
    const label = await app.db.query(uid).create({ data: { Title: title, external_source: TEST_PREFIX } });
    factories.remember(uid, label.id);
    relations[`product_variation_${kind}`] = label.id;
  }
  await app.db.query("api::product-variation.product-variation")
    .update({ where: { id: live.id }, data: relations });
  const soldOut = await factories.createVariation({ productId: product.id, stockCount: 3, stockReserved: 3 });
  const unpublished = await factories.createVariation({ productId: product.id, isPublished: false, stockCount: 1 });
  const draftVariation = await factories.createVariation({ productId: draft.id, stockCount: 5 });
  const ids = [live.id, soldOut.id, unpublished.id, draftVariation.id].join(",");
  const url = `/bale/v1/inventory?ids=${ids}`;
  expect((await call(url, { token: "incorrect" })).response.status).toBe(401);
  const inventory = await call(url, { token: BOT_TOKEN });
  expect(inventory.response.status).toBe(200);
  expect(inventory.response.headers.get("cache-control")).toContain("no-store");
  expect(inventory.body).toEqual({ items: [
    { variationId: live.id, sku: live.SKU, productTitle: product.Title, ...labels, priceToman: 130000, availableQuantity: 2 },
    {
      variationId: soldOut.id, sku: soldOut.SKU, productTitle: product.Title, color: null, size: null, model: null,
      priceToman: 100000, availableQuantity: 0,
    },
  ] });
  const sku = await call(`/bale/v1/inventory?skus=${encodeURIComponent(live.SKU)}`, { token: BOT_TOKEN });
  expect(sku.body.items).toEqual([inventory.body.items[0]]);
  expect((await call(`${url}&skus=anything`, { token: BOT_TOKEN })).response.status).toBe(400);
  expect((await call("/bale-checkouts", { token: BOT_TOKEN })).response.status).toBe(404);

  const shortage = await create("bale-short", [{ variationId: live.id, quantity: 3 }]);
  expect(shortage.response.status).toBe(409);
  expect(shortage.body.error.details).toEqual({
    errorCode: "BALE_ITEMS_UNAVAILABLE", items: [{ variationId: live.id, availableQuantity: 2 }],
  });
  redis.eval.mockResolvedValueOnce([0, 2]);
  const limited = await call(url, { token: BOT_TOKEN });
  expect(limited.response.status).toBe(429);
  expect(limited.response.headers.get("retry-after")).toBe("2");
});

it("replays idempotently, claims one owner, and only reads the linked payment", async () => {
  const product = await factories.createProduct({ status: "Active" });
  const variation = await factories.createVariation({ productId: product.id, stockCount: 3, stockReserved: 1, discountPrice: 90000 });
  const items = [{ variationId: variation.id, quantity: 2 }];
  const [a, b] = await Promise.all([
    create("bale-race", items),
    create("bale-race", [{ variationId: variation.id, quantity: 1 }, { variationId: variation.id, quantity: 1 }]),
  ]);
  expect(a.response.status).toBe(200);
  expect(b.response.status).toBe(200);
  expect(b.body).toEqual(a.body);
  const { checkoutId, checkoutUrl, expiresAt } = a.body;
  expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(59 * 60_000);
  expect((await factories.getStock(variation.stockId)).reservedCount).toBe(1);
  const link = new URL(checkoutUrl);
  expect(link.origin).toBe("https://storefront.test.invalid");
  expect(link.pathname).toBe(`/bale/checkout/${checkoutId}`);
  expect(link.search).toBe("");

  process.env.BALE_CHECKOUT_NEW_ENABLED = "false";
  expect((await create("bale-race", items)).body).toEqual(a.body);
  expect((await create("bale-race", [{ variationId: variation.id, quantity: 1 }])).response.status).toBe(409);
  expect((await create("bale-new", items)).response.status).toBe(503);
  expect((await status(checkoutId)).body).toEqual({ checkoutId, status: "ready" });
  expect((await status(checkoutId, "some-other-chat")).response.status).toBe(404);

  const [first, second] = await Promise.all([customer(), customer()]);
  const storefrontPath = `/bale/checkout/${checkoutId}`;
  const claim = (token: string, grant = link.hash.slice(1)) => call(`${storefrontPath}/claim`, {
    token, body: { grant },
  });
  expect((await claim(BOT_TOKEN)).response.status).toBe(401);
  expect((await claim(first.token, "x".repeat(43))).response.status).toBe(404);
  const claims = await Promise.all([claim(first.token), claim(second.token)]);
  expect(claims.map((entry) => entry.response.status).sort()).toEqual([200, 404]);
  const winner = claims[0].response.ok ? first : second;
  const loser = claims[0].response.ok ? second : first;
  const owned = await call(storefrontPath, { token: winner.token });
  expect(owned.body).toEqual({
    checkoutId, orderId: null, expiresAt, baleReturnUrl: `https://ble.ir/Integration_bot?start=${checkoutId}`,
  });
  expect((await claim(winner.token)).body).toEqual(owned.body);
  expect((await call(storefrontPath, { token: loser.token })).response.status).toBe(404);

  const checkout = await readOwnedBaleCheckout(app, checkoutId, winner.id);
  expect(checkout?.items).toEqual(items);
  const virtual = await loadBaleCheckoutCart(app, {
    ...checkout!, items: [...items, { variationId: 2_147_483_647, quantity: 1 }],
  });
  expect(virtual.Status).toBe("Pending");
  expect(virtual.cart_items[0].Sum).toBe(180000);
  expect(virtual.cart_items[0]).not.toHaveProperty("id");
  expect(virtual.cart_items[0].product_variation.product.Title).toBe(product.Title);
  expect(virtual.cart_items[1]).toEqual({
    variationId: 2_147_483_647, Count: 1, Sum: 0, product_variation: null,
  });

  const contract = await factories.createContract({ userId: winner.id, amount: 200000 });
  const order = await factories.createOrder({ userId: winner.id, contractId: contract.id });
  const attempt = await factories.createPaymentAttempt({
    userId: winner.id, orderId: order.id, contractId: contract.id, amountIrr: 2_000_000, status: "Pending",
  });
  const linkOrder = () => app.db.connection.transaction(async (trx: any) => {
    const locked = await lockOwnedBaleCheckout(trx, checkoutId, winner.id);
    await linkBaleCheckoutOrder(trx, locked!, order.id, attempt.attemptId);
  });
  await linkOrder();
  await expect(linkOrder()).rejects.toMatchObject({ code: "BALE_CHECKOUT_LINKED" });
  expect((await readBaleCheckoutForOrder(app, order.id))?.checkoutId).toBe(checkoutId);
  expect((await readBaleCheckoutForAttempt(app, attempt.attemptId, winner.id))?.checkoutId).toBe(checkoutId);
  await expect(readBaleCheckoutForAttempt(app, attempt.attemptId, loser.id)).resolves.toBeNull();

  await app.db.connection("bale_checkouts").where({ checkout_id: checkoutId })
    .update({ expires_at: new Date(Date.now() - 60_000).toISOString() });
  expect((await status(checkoutId)).body).toEqual({ checkoutId, status: "payment_pending" });
  expect((await call(storefrontPath, { token: winner.token })).body.orderId).toBe(order.id);
  for (const [stored, external] of [
    ["Failed", "failed"], ["Cancelled", "cancelled"], ["Expired", "expired"], ["Succeeded", "paid"],
  ]) {
    await app.db.connection("payment_attempts").where({ id: attempt.id }).update({ status: stored });
    const body = (await status(checkoutId)).body;
    expect(body).toMatchObject({
      checkoutId, status: external, ...(external === "paid" ? { orderNumber: order.id } : {}),
    });
    if (external !== "paid") expect(body).toEqual({ checkoutId, status: external });
    else {
      // The factory order has no lines; the hosted checkout spec covers real items.
      expect(body.order).toMatchObject({ orderStatus: expect.any(String), trackingCode: null });
      expect(Array.isArray(body.order.items)).toBe(true);
    }
    expect((await app.db.connection("payment_attempts").where({ id: attempt.id }).first()).status).toBe(stored);
  }

  const providerResponse = withIssuedSnappayToken({}, {
    seq: 1,
    transactionId: "BALE-TEST",
    callbackNonceHash: "test-hash",
    paymentTokenFingerprint: "test-fingerprint",
    paymentToken: "test-token",
  });
  const attemptRow = () => app.db.connection("payment_attempts").where({ id: attempt.id });
  await attemptRow().update({
    gateway: "SnappPay",
    status: "Cancelled",
    provider_status: "PENDING",
    provider_response: JSON.stringify(providerResponse),
  });
  expect((await status(checkoutId)).body).toEqual({ checkoutId, status: "payment_pending" });
  await attemptRow().update({ provider_status: "CANCEL" });
  expect((await status(checkoutId)).body).toEqual({ checkoutId, status: "cancelled" });
});

it("expires an unclaimed link without assigning an owner", async () => {
  const product = await factories.createProduct({ status: "Active" });
  const variation = await factories.createVariation({ productId: product.id, stockCount: 1 });
  const { response, body } = await create("bale-expired", [{ variationId: variation.id, quantity: 1 }]);
  expect(response.status).toBe(200);
  const { checkoutId, checkoutUrl } = body;
  await app.db.connection("bale_checkouts").where({ checkout_id: checkoutId })
    .update({ expires_at: new Date(Date.now() - 60_000).toISOString() });
  const user = await customer();
  const claim = await call(`/bale/checkout/${checkoutId}/claim`, {
    token: user.token, body: { grant: new URL(checkoutUrl).hash.slice(1) },
  });
  expect(claim.response.status).toBe(410);
  expect((await status(checkoutId)).body).toEqual({ checkoutId, status: "expired" });
  await expect(readOwnedBaleCheckout(app, checkoutId, user.id)).resolves.toBeNull();
});

it("searches public products, lists places, quotes shipping, and validates the recipient", async () => {
  const product = await factories.createProduct({ status: "Active" });
  const hidden = await factories.createProduct({ status: "InActive" });
  const live = await factories.createVariation({ productId: product.id, price: 200000, stockCount: 4 });
  await factories.createVariation({ productId: hidden.id, stockCount: 4 });
  const city = await factories.createShippingCity({ title: "Bale quote city" });
  const shipping = await app.db.query("api::shipping.shipping").create({
    data: { Title: "Bale quote shipping", Code: `bale-quote-${live.id}`, IsActive: true, Price: 45000 },
  });
  factories.remember("api::shipping.shipping", shipping.id);

  expect((await call(`/bale/v1/products?q=${encodeURIComponent(product.Title)}`)).response.status).toBe(401);
  const found = await call(`/bale/v1/products?q=${encodeURIComponent(product.Title)}`, { token: BOT_TOKEN });
  expect(found.response.status).toBe(200);
  expect(found.body.items).toEqual([expect.objectContaining({
    productId: product.id, title: product.Title, inStock: true, minPriceToman: 200000,
    variations: [expect.objectContaining({ variationId: live.id, availableQuantity: 4 })],
  })]);
  expect((await call(`/bale/v1/products?q=${encodeURIComponent(hidden.Title)}`, { token: BOT_TOKEN })).body.items)
    .toEqual([]);
  expect((await call(`/bale/v1/products/${product.id}`, { token: BOT_TOKEN })).body.productId).toBe(product.id);
  expect((await call(`/bale/v1/products/${hidden.id}`, { token: BOT_TOKEN })).response.status).toBe(404);
  expect((await call("/bale/v1/products?pageSize=0", { token: BOT_TOKEN })).response.status).toBe(400);

  expect((await call("/bale/v1/provinces", { token: BOT_TOKEN })).body.items)
    .toContainEqual({ id: city.provinceId, title: expect.any(String) });
  expect((await call(`/bale/v1/provinces/${city.provinceId}/cities`, { token: BOT_TOKEN })).body.items)
    .toEqual([{ id: city.id, title: "Bale quote city" }]);

  const items = [{ variationId: live.id, quantity: 2 }];
  const quote = await call("/bale/v1/quote", {
    token: BOT_TOKEN, body: { items, cityId: city.id, shippingMethodId: shipping.id },
  });
  expect(quote.response.status).toBe(200);
  expect(quote.body).toMatchObject({
    city: { cityId: city.id, provinceId: city.provinceId },
    items: [{ variationId: live.id, quantity: 2, unitPriceToman: 200000, lineTotalToman: 400000 }],
    subtotalToman: 400000,
    shippingToman: 45000,
    totalToman: 445000,
  });
  expect((await call("/bale/v1/quote", {
    token: BOT_TOKEN, body: { items, cityId: 2_000_000_000 },
  })).body.error.details.errorCode).toBe("BALE_INVALID_CITY");
  expect((await call("/bale/v1/quote", {
    token: BOT_TOKEN, body: { items: [{ variationId: live.id, quantity: 5 }], cityId: city.id },
  })).response.status).toBe(409);

  const recipient = {
    fullName: "Bale Recipient", phone: "+989121112233", cityId: city.id,
    postalCode: "1234567890", address: "Integration street, number 10",
  };
  const bad = (patch: object, extra: object = {}) => call("/bale/v1/checkouts", {
    token: BOT_TOKEN, chat: CHAT_REF, key: `bale-bad-${Math.random()}`,
    body: { items, recipient: { ...recipient, ...patch }, ...extra },
  });
  for (const patch of [{ phone: "021-1234" }, { postalCode: "12345" }, { address: "x" }, { extra: 1 }]) {
    expect((await bad(patch)).response.status).toBe(400);
  }
  expect((await bad({ cityId: 2_000_000_000 })).response.status).toBe(400);
  expect((await bad({}, { shippingMethodId: 2_000_000_000 })).body.error.details.errorCode)
    .toBe("BALE_SHIPPING_UNAVAILABLE");
  expect((await call("/bale/v1/checkouts", {
    token: BOT_TOKEN, chat: CHAT_REF, key: "bale-no-address", body: { items, shippingMethodId: shipping.id },
  })).response.status).toBe(400);

  const created = await call("/bale/v1/checkouts", {
    token: BOT_TOKEN, chat: CHAT_REF, key: "bale-addressed", body: { items, recipient, shippingMethodId: shipping.id },
  });
  expect(created.response.status).toBe(200);
  expect(created.body.recipient.phone).toBe("09121112233");
  expect(created.body.quote.totalToman).toBe(445000);
  const replay = await call("/bale/v1/checkouts", {
    token: BOT_TOKEN, chat: CHAT_REF, key: "bale-addressed", body: { items, recipient, shippingMethodId: shipping.id },
  });
  expect(replay.body).toEqual(created.body);
  expect((await call("/bale/v1/checkouts", {
    token: BOT_TOKEN, chat: CHAT_REF, key: "bale-addressed", body: { items },
  })).response.status).toBe(409);
  expect((await call("/bale/v1/orders", { token: BOT_TOKEN, chat: CHAT_REF })).body)
    .toEqual({ items: [], pagination: { page: 1, pageSize: 10, total: 0, pageCount: 0 } });
});
