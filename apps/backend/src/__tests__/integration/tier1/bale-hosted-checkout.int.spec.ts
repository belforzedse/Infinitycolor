import { createServer } from "node:http";
import { makeFactories } from "../factories";
import { setupStrapi, teardownStrapi } from "../strapiInstance";
import { loadBaleCheckoutCart, readOwnedBaleCheckout } from "../../../api/bale-checkout/services/handoff";
import { supersedeCheckoutAttempt } from "../../../api/cart/services/lib/checkout-supersede";
import { readWalletAvailability } from "../../../api/local-user-wallet/services/wallet-holds";
import { refreshWalletReadiness } from "../../../api/local-user-wallet/services/wallet-readiness";

it("pays one Bale order from concurrent hosted checkout submissions and preserves the site cart", async () => {
  const botToken = "fixture-bale-bot-credential";
  process.env.STRAPI_ENABLE_DOCUMENTATION = "false";
  process.env.BETTER_AUTH_BRIDGE_ENABLED = "false";
  process.env.BALE_BOT_API_TOKEN = botToken;
  process.env.BALE_CHECKOUT_GRANT_SECRET = "fixture-bale-checkout-grant-secret-32";
  process.env.BALE_BOT_USERNAME = "Integration_bot";
  process.env.FRONTEND_BASE_URL = "https://storefront.test.invalid";
  process.env.WALLET_HOLDS_ENABLED = "true";
  const strapi = await setupStrapi();
  await refreshWalletReadiness(strapi);
  const f = makeFactories(strapi);
  strapi.server.mount();
  const server = createServer(strapi.server.app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const redis = await require(`${process.env.INTEGRATION_DIST_DIR}/src/index`).RedisClient;
  redis.isReady = true;
  redis.eval = jest.fn().mockResolvedValue([1, 0]);

  const call = async (path: string, token: string, body?: object, headers?: Record<string, string>) => {
    const response = await fetch(`${origin}/api${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };

  const checkoutIds: string[] = [];
  let customerId: number | undefined;
  const permissions: number[] = [];
  try {
    const customer = await f.createUser();
    customerId = customer.id;
    const role = await strapi.db.query("plugin::users-permissions.role").findOne({
      where: { type: "authenticated" },
    });
    await strapi.db.query("plugin::users-permissions.user").update({
      where: { id: customer.id }, data: { role: role.id },
    });
    const permission = strapi.db.query("plugin::users-permissions.permission");
    for (const action of [
      "api::cart.cart.getMyCart", "api::cart.cart.shippingOptions", "api::cart.cart.checkoutQuote",
      "api::cart.cart.finalizeToOrder", "api::cart.cart.checkStock", "api::order.order.checkPaymentStatus",
    ]) {
      const data = { role: role.id, action };
      if (!(await permission.findOne({ where: data }))) {
        permissions.push((await permission.create({ data })).id);
      }
    }
    await f.createUserInfo({ userId: customer.id });
    const jwt = strapi.plugin("users-permissions").service("jwt").issue({ id: customer.id });
    const cart = await f.createCart({ userId: customer.id });
    const regularProduct = await f.createProduct({ status: "Active" });
    const regular = await f.createVariation({ productId: regularProduct.id, stockCount: 5 });
    const regularLine = await f.createCartItem({ cartId: cart.id, variationId: regular.id, count: 1 });
    const baleProduct = await f.createProduct({ status: "Active" });
    const bale = await f.createVariation({
      productId: baleProduct.id, stockCount: 5, price: 150000, discountPrice: 130000,
    });
    const shipping = await strapi.db.query("api::shipping.shipping").create({
      data: {
        Title: "Bale fixture shipping",
        Code: "bale-fixture-shipping",
        IsActive: true,
        Price: 70000,
        Rules: [{ id: "bale-product", active: true, productIds: [baleProduct.id], price: 33000 }],
      },
    });
    f.remember("api::shipping.shipping", shipping.id);
    const address = await f.createAddress({ userId: customer.id, postalCode: "1234567890" });
    await f.createPaymentGateway({ title: "Wallet", isActive: true });
    await f.createWallet({ userId: customer.id, balanceIrr: 10_000_000 });

    const chat = { "X-Bale-Chat-Ref": "hosted-checkout-fixture" };
    const link = await call("/bale/v1/checkouts", botToken, {
      items: [{ variationId: bale.id, quantity: 1 }],
    }, { ...chat, "Idempotency-Key": "hosted-checkout-race" });
    expect(link.status).toBe(200);
    const checkoutId = link.body.checkoutId;
    checkoutIds.push(checkoutId);
    const claim = await call(`/bale/checkout/${checkoutId}/claim`, jwt, {
      grant: new URL(link.body.checkoutUrl).hash.slice(1),
    });
    expect(claim.status).toBe(200);

    const scope = `?baleCheckoutId=${checkoutId}`;
    const scopedCart = await call(`/carts/me${scope}`, jwt);
    expect(scopedCart.body.data.cart_items).toMatchObject([{
      Sum: 130000, product_variation: { id: bale.id },
    }]);
    const methods = await call(`/carts/shipping-options${scope}`, jwt, { addressId: address.id });
    expect(methods.body.data.methods).toContainEqual(expect.objectContaining({ id: shipping.id, price: 33000 }));

    const checkoutInput = { shipping: shipping.id, addressId: address.id, gateway: "wallet" };
    const quote = await call(`/carts/quote${scope}`, jwt, checkoutInput);
    expect(quote.status).toBe(200);
    expect(quote.body.data.financialSummary).toMatchObject({
      subtotal: 130000, shipping: 33000, total: 163000,
    });
    const quoteHash = quote.body.data.quoteHash;
    const attempts = await Promise.all(["bale-race-left", "bale-race-right"].map((attemptId) =>
      call(`/carts/finalize${scope}`, jwt, { ...checkoutInput, attemptId, quoteHash }),
    ));
    const paid = attempts.find((attempt) => attempt.body.data?.paymentStatus === "Succeeded");
    expect(paid?.status).toBe(200);
    const orderId = paid!.body.data.orderId;
    const orders = await strapi.db.query("api::order.order").findMany({
      where: { user: { id: customer.id } }, populate: { order_items: true },
    });
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      id: orderId,
      BaleCheckoutId: checkoutId,
      Status: "Started",
      order_items: [{ SourceCartItemId: null }],
    });
    expect(Number(orders[0].order_items[0].PerAmount)).toBe(130000);
    expect((await f.getStock(bale.stockId)).Count).toBe(4);
    expect((await f.getStock(regular.stockId)).Count).toBe(5);
    const regularCart = await call("/carts/me", jwt);
    expect(regularCart.body.data.cart_items).toMatchObject([{ id: regularLine.id, Count: 1 }]);

    const result = await call(`/orders/${orderId}/payment-status`, jwt);
    expect(result.body.data).toMatchObject({
      isPaid: true,
      baleReturnUrl: `https://ble.ir/Integration_bot?start=${checkoutId}`,
    });
    expect((await call(`/bale/v1/checkouts/${checkoutId}`, botToken, undefined, chat)).body)
      .toMatchObject({ checkoutId, status: "paid", orderNumber: orderId, order: {
        orderStatus: "Started", orderStatusLabel: "در حال انجام", trackingCode: null,
        totalToman: 163000, items: [{ quantity: 1, unitPriceToman: 130000 }],
      } });
    expect((await call(`/carts/check-stock?attemptId=${paid!.body.data.attemptId}`, jwt)).status).toBe(400);

    const anotherLink = await call("/bale/v1/checkouts", botToken, {
      items: [{ variationId: bale.id, quantity: 1 }],
    }, { ...chat, "Idempotency-Key": "hosted-checkout-reopen" });
    const reopenId = anotherLink.body.checkoutId;
    checkoutIds.push(reopenId);
    const reopenPath = `/bale/checkout/${reopenId}`;
    await call(`${reopenPath}/claim`, jwt, { grant: new URL(anotherLink.body.checkoutUrl).hash.slice(1) });
    const reopenScope = `?baleCheckoutId=${reopenId}`;
    const reopenQuote = await call(`/carts/quote${reopenScope}`, jwt, checkoutInput);
    const resume = { gateway: "wallet", attemptId: "bale-interrupted", quoteHash: reopenQuote.body.data.quoteHash };
    const owned = (await readOwnedBaleCheckout(strapi, reopenId, customer.id))!;
    // Stop after the order and payment attempt commit, before the HTTP handler debits the wallet.
    const interrupted = await strapi.service("api::cart.cart").finalizeCartToOrder(customer.id, {
      ...resume, shippingId: shipping.id, shippingCost: 33000, addressId: address.id,
    }, { checkout: owned, cart: await loadBaleCheckoutCart(strapi, owned) });
    expect(interrupted.paymentAttempt.Status).toBe("Created");

    expect((await call("/carts/finalize", jwt, { supersedeAttemptId: [resume.attemptId] })).status).toBe(400);
    await expect(supersedeCheckoutAttempt(strapi, {
      userId: customer.id, attemptId: resume.attemptId, replacementAttemptId: "other-cart",
    })).resolves.toMatchObject({ outcome: "refused" });
    expect((await readWalletAvailability(strapi, customer.id, { reusableAttemptId: resume.attemptId })).reusableIrr).toBe(0);
    expect((await call(reopenPath, jwt)).body).toMatchObject({ orderId: interrupted.order.id, resume });
    const recovered = await call(`/carts/finalize${reopenScope}`, jwt, resume);
    expect(recovered.body.data).toMatchObject({
      orderId: interrupted.order.id, attemptId: resume.attemptId, paymentStatus: "Succeeded",
    });
    expect((await f.getStock(bale.stockId)).Count).toBe(3);

    // A link created with the recipient the bot collected: the site cannot swap the address.
    const city = await f.createShippingCity({ title: "شهر ربات" });
    const recipient = {
      fullName: "گیرنده ربات", phone: "۰۹۱۲۳۴۵۶۷۸۹", cityId: city.id,
      postalCode: "۱۱۱۱۱۲۲۲۲۲", address: "خیابان آزمایشی، پلاک ۱۲، واحد ۳",
    };
    const botQuote = await call("/bale/v1/quote", botToken, {
      items: [{ variationId: bale.id, quantity: 1 }], cityId: city.id,
    });
    expect(botQuote.status).toBe(200);
    expect(botQuote.body).toMatchObject({
      subtotalToman: 130000, discountToman: 0,
      shippingOptions: expect.arrayContaining([expect.objectContaining({
        id: shipping.id, priceToman: 33000, totalToman: 163000,
      })]),
    });
    const addressed = await call("/bale/v1/checkouts", botToken, {
      items: [{ variationId: bale.id, quantity: 1 }], recipient, shippingMethodId: shipping.id,
    }, { ...chat, "Idempotency-Key": "hosted-checkout-addressed" });
    expect(addressed.status).toBe(200);
    expect(addressed.body.recipient).toMatchObject({
      phone: "09123456789", postalCode: "1111122222", cityTitle: "شهر ربات",
    });
    expect(addressed.body.quote).toMatchObject({ shippingToman: 33000, totalToman: 163000 });
    const addressedId = addressed.body.checkoutId;
    checkoutIds.push(addressedId);
    const addressedPath = `/bale/checkout/${addressedId}`;
    const addressedClaim = await call(`${addressedPath}/claim`, jwt, {
      grant: new URL(addressed.body.checkoutUrl).hash.slice(1),
    });
    expect(addressedClaim.body).toMatchObject({
      shippingMethodId: shipping.id,
      recipient: { fullName: "گیرنده ربات", cityId: city.id, provinceId: city.provinceId },
    });
    const addressedScope = `?baleCheckoutId=${addressedId}`;
    // The page tries to use the shopper's saved address; the bot's address wins.
    // A reserve group id would otherwise route the parcel to the group's address.
    const swapped = { ...checkoutInput, addressId: address.id, reserveGroupId: "not-a-group", mobile: "09350000000" };
    const addressedQuote = await call(`/carts/quote${addressedScope}`, jwt, swapped);
    expect(addressedQuote.body.data.financialSummary).toMatchObject({ total: 163000 });
    const addressedPaid = await call(`/carts/finalize${addressedScope}`, jwt, {
      ...swapped, attemptId: "bale-addressed", quoteHash: addressedQuote.body.data.quoteHash,
    });
    expect(addressedPaid.body.data.paymentStatus).toBe("Succeeded");
    const addressedOrder = await strapi.db.query("api::order.order").findOne({
      where: { id: addressedPaid.body.data.orderId },
      populate: { delivery_address: { populate: { shipping_city: true } } },
    });
    expect(addressedOrder.delivery_address).toMatchObject({
      PostalCode: "1111122222", FullName: "گیرنده ربات", Phone: "09123456789",
      FullAddress: recipient.address, shipping_city: { id: city.id },
    });
    f.remember("api::local-user-address.local-user-address", addressedOrder.delivery_address.id);
    await strapi.db.query("api::order.order").update({
      where: { id: addressedOrder.id }, data: { Status: "Shipment", ShippingBarcode: "TRACK-123" },
    });
    const history = await call("/bale/v1/orders?pageSize=2", botToken, undefined, chat);
    expect(history.status).toBe(200);
    expect(history.body.pagination).toEqual({ page: 1, pageSize: 2, total: 3, pageCount: 2 });
    expect(history.body.items[0]).toMatchObject({
      checkoutId: addressedId, status: "paid", orderNumber: addressedOrder.id,
      order: { orderStatus: "Shipment", orderStatusLabel: "ارسال شده", trackingCode: "TRACK-123" },
    });
    expect((await call("/bale/v1/orders", botToken, undefined, {
      "X-Bale-Chat-Ref": "someone-else",
    })).body.items).toEqual([]);
  } finally {
    if (checkoutIds.length) await strapi.db.connection("bale_checkouts").whereIn("checkout_id", checkoutIds).delete();
    if (customerId) {
      const createdOrders = await strapi.db.query("api::order.order").findMany({
        where: { user: { id: customerId } },
        populate: { order_items: true, contract: true },
      });
      for (const order of createdOrders) {
        f.remember("api::order.order", order.id);
        if (order.contract?.id) f.remember("api::contract.contract", order.contract.id);
        for (const line of order.order_items) f.remember("api::order-item.order-item", line.id);
        const attempt = await strapi.db.query("api::payment-attempt.payment-attempt").findOne({
          where: { order: { id: order.id } },
        });
        if (attempt) f.remember("api::payment-attempt.payment-attempt", attempt.id);
      }
    }
    for (const id of permissions) {
      await strapi.db.query("plugin::users-permissions.permission").delete({ where: { id } });
    }
    await f.cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await teardownStrapi();
  }
});
