import { expect, test } from "@playwright/test";
import {
  cleanupRuntimeOrders,
  cleanupRuntimeProducts,
  createRuntimeOrder,
} from "../../helpers/admin";
import {
  authHeaders,
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  expectApiForbidden,
  expectApiOk,
} from "../../helpers/api";
import { authCredentials } from "../../helpers/auth";
import { strapiApiURL } from "../../helpers/env";

const created = {
  products: [] as number[],
  variations: [] as number[],
  colors: [] as number[],
  categories: [] as number[],
  discounts: [] as number[],
  shipping: [] as number[],
  reviews: [] as number[],
  replies: [] as number[],
  uploads: [] as number[],
};

const readId = async (response: import("@playwright/test").APIResponse) => {
  const payload = (await response.json()) as { data?: { id?: number } };
  return Number(payload.data?.id);
};

test.describe("Store manager operational commerce CRUD", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupRuntimeProducts(request);
    await cleanupRuntimeOrders(request);
  });

  test.afterEach(async ({ request }) => {
    await cleanupRuntimeProducts(request);
    await cleanupRuntimeOrders(request);
    for (const [path, ids] of [
      ["product-review-replies", created.replies],
      ["product-reviews", created.reviews],
      ["product-variations", created.variations],
      ["products", created.products],
      ["product-variation-colors", created.colors],
      ["product-categories", created.categories],
      ["discounts", created.discounts],
      ["shippings", created.shipping],
      ["upload/files", created.uploads],
    ] as const) {
      for (const id of ids.splice(0)) {
        await apiDelete(request, "admin", `/${path}/${id}`);
      }
    }
  });

  test("@permissions @api completes variation, promotion, shipping, and category workflows while sensitive APIs stay closed", async ({
    request,
  }) => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const category = await apiPost(
      request,
      "store-manager",
      "/product-categories",
      {
        data: {
          Title: `Manager category ${suffix}`,
          Slug: `manager-category-${suffix}`,
        },
      },
    );
    await expectApiOk(category, "Store manager category create");
    const categoryId = await readId(category);
    expect(categoryId).toBeGreaterThan(0);
    created.categories.push(categoryId);
    await expectApiOk(
      await apiPut(
        request,
        "store-manager",
        `/product-categories/${categoryId}`,
        {
          data: { featured: true },
        },
      ),
      "Store manager category update",
    );
    await expectApiForbidden(
      await apiDelete(
        request,
        "store-manager",
        `/product-categories/${categoryId}`,
      ),
    );

    const product = await apiPost(request, "store-manager", "/products", {
      data: {
        Title: `Manager product ${suffix}`,
        Slug: `manager-product-${suffix}`,
        Status: "InActive",
        ProductType: "Variable",
        product_main_category: categoryId,
      },
    });
    await expectApiOk(product, "Store manager product create");
    const productId = await readId(product);
    expect(productId).toBeGreaterThan(0);
    created.products.push(productId);
    await expectApiOk(
      await apiGet(request, "store-manager", `/products/${productId}`),
      "Store manager product read",
    );
    await expectApiOk(
      await apiPut(request, "store-manager", `/products/${productId}`, {
        data: { Status: "Active", Description: "Published by Store manager" },
      }),
      "Store manager product publish",
    );

    const uploadResponse = await request.post(
      `${strapiApiURL().replace(/\/$/, "")}/upload`,
      {
        headers: await authHeaders("store-manager"),
        multipart: {
          files: {
            name: `manager-media-${suffix}.png`,
            mimeType: "image/png",
            buffer: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
              "base64",
            ),
          },
        },
      },
    );
    await expectApiOk(uploadResponse, "Store manager media upload");
    const uploadBody = (await uploadResponse.json()) as Array<{ id?: number }>;
    const uploadId = Number(uploadBody[0]?.id);
    expect(uploadId).toBeGreaterThan(0);
    created.uploads.push(uploadId);
    await expectApiOk(
      await apiPut(request, "store-manager", `/products/${productId}`, {
        data: { Media: [uploadId] },
      }),
      "Store manager media attachment",
    );

    const colorResponse = await apiPost(
      request,
      "store-manager",
      "/product-variation-colors",
      {
        data: { Title: `Manager color ${suffix}`, ColorCode: "#334455" },
      },
    );
    await expectApiOk(colorResponse, "Store manager color create");
    const colorId = await readId(colorResponse);
    created.colors.push(colorId);

    const generation = await apiPost(
      request,
      "store-manager",
      `/products/${productId}/variation-combinations`,
      { axes: [{ type: "color", termIds: [colorId] }] },
    );
    await expectApiOk(generation, "Store manager variation generation");
    const generationBody = (await generation.json()) as {
      data?: { createdIds?: number[] };
    };
    const variationId = Number(generationBody.data?.createdIds?.[0]);
    expect(variationId).toBeGreaterThan(0);
    created.variations.push(variationId);

    const variationUpdate = await apiPut(
      request,
      "store-manager",
      `/product-variations/${variationId}`,
      { data: { SKU: `MANAGER-${suffix}`, Price: 250000, IsPublished: true } },
    );
    await expectApiOk(variationUpdate, "Store manager variation update");

    const variationRead = await apiGet(
      request,
      "store-manager",
      `/product-variations/${variationId}?populate=product_stock`,
    );
    await expectApiOk(variationRead, "Store manager variation read");
    const variationBody = (await variationRead.json()) as any;
    const stockId = Number(
      variationBody.data?.attributes?.product_stock?.data?.id ||
        variationBody.data?.product_stock?.id,
    );
    expect(stockId).toBeGreaterThan(0);

    const stockUpdate = await apiPut(
      request,
      "store-manager",
      `/product-stocks/${stockId}`,
      {
        data: { Count: 17 },
      },
    );
    await expectApiOk(stockUpdate, "Store manager stock update");
    const protectedStockWrite = await apiPut(
      request,
      "store-manager",
      `/product-stocks/${stockId}`,
      { data: { reservedCount: 0 } },
    );
    expect([400, 403]).toContain(protectedStockWrite.status());

    const discount = await apiPost(request, "store-manager", "/discounts", {
      data: {
        Code: `MGR-${suffix}`,
        Type: "Discount",
        Amount: 5,
        StartDate: new Date().toISOString(),
        EndDate: new Date(Date.now() + 86_400_000).toISOString(),
        IsActive: true,
      },
    });
    await expectApiOk(discount, "Store manager discount create");
    const discountId = await readId(discount);
    created.discounts.push(discountId);
    const protectedDiscountWrite = await apiPut(
      request,
      "store-manager",
      `/discounts/${discountId}`,
      { data: { UsedTimes: 999 } },
    );
    expect([400, 403]).toContain(protectedDiscountWrite.status());
    await expectApiOk(
      await apiPut(request, "store-manager", `/discounts/${discountId}`, {
        data: { removedAt: new Date().toISOString() },
      }),
      "Store manager discount archive",
    );

    const shipping = await apiPost(request, "store-manager", "/shippings", {
      data: {
        Title: `Manager shipping ${suffix}`,
        Code: `mgr-${suffix}`,
        Price: 10000,
        IsActive: true,
      },
    });
    await expectApiOk(shipping, "Store manager shipping create");
    const shippingId = await readId(shipping);
    created.shipping.push(shippingId);
    await expectApiOk(
      await apiPut(request, "store-manager", `/shippings/${shippingId}`, {
        data: { removedAt: new Date().toISOString() },
      }),
      "Store manager shipping archive",
    );

    const customerSearch = await apiGet(
      request,
      "store-manager",
      `/sp/customers/search?q=${encodeURIComponent(authCredentials("customer").phone.slice(-7))}&pageSize=3`,
    );
    await expectApiOk(
      customerSearch,
      "Store manager sanitized customer search",
    );
    const customerSearchBody = (await customerSearch.json()) as {
      data?: Array<Record<string, unknown>>;
    };
    expect(customerSearchBody.data?.length).toBeGreaterThan(0);
    for (const customer of customerSearchBody.data || []) {
      expect(Object.keys(customer).sort()).toEqual(
        ["firstName", "id", "isActive", "lastName", "phone"].sort(),
      );
    }

    const reviewResponse = await apiPost(
      request,
      "customer",
      "/product-reviews/submit",
      {
        productId,
        rate: 5,
        content: `Permission review ${suffix}`,
      },
    );
    await expectApiOk(reviewResponse, "Customer review submission");
    const reviewBody = (await reviewResponse.json()) as any;
    const reviewId = Number(reviewBody.data?.id || reviewBody.id);
    expect(reviewId).toBeGreaterThan(0);
    created.reviews.push(reviewId);
    await expectApiOk(
      await apiPut(request, "store-manager", `/product-reviews/${reviewId}`, {
        data: { Status: "Accepted" },
      }),
      "Store manager review moderation",
    );
    const replyResponse = await apiPost(
      request,
      "store-manager",
      "/product-review-replies",
      {
        data: { Content: `Manager reply ${suffix}`, product_review: reviewId },
      },
    );
    await expectApiOk(replyResponse, "Store manager review reply");
    const replyId = await readId(replyResponse);
    expect(replyId).toBeGreaterThan(0);
    created.replies.push(replyId);
    await expectApiOk(
      await apiPut(request, "store-manager", `/product-reviews/${reviewId}`, {
        data: { removedAt: new Date().toISOString() },
      }),
      "Store manager review soft delete",
    );

    const order = await createRuntimeOrder(request);
    await expectApiOk(
      await apiGet(request, "store-manager", `/orders/${order.orderId}`),
      "Store manager order detail",
    );
    await expectApiOk(
      await apiPut(
        request,
        "store-manager",
        `/orders/${order.orderId}/admin/notes`,
        {
          data: { Note: `Manager note ${suffix}` },
        },
      ),
      "Store manager controlled order note update",
    );
    await expectApiOk(
      await apiPost(
        request,
        "store-manager",
        `/orders/${order.orderId}/admin/transition`,
        { status: "Done" },
      ),
      "Store manager controlled order completion",
    );
    await expectApiOk(
      await apiPost(
        request,
        "store-manager",
        `/orders/${order.orderId}/admin/transition`,
        { status: "Shipment" },
      ),
      "Store manager controlled order shipment",
    );

    await expectApiForbidden(
      await apiGet(request, "store-manager", "/payment-gateways"),
    );
    await expectApiForbidden(
      await apiGet(
        request,
        "store-manager",
        `/orders/${order.orderId}/admin/payment-operations/999999`,
      ),
    );
    await expectApiForbidden(
      await apiGet(request, "store-manager", "/reports/liquidity"),
    );
    await expectApiForbidden(
      await apiGet(request, "store-manager", "/event-logs/admin"),
    );
    await expectApiForbidden(
      await apiPut(request, "store-manager", "/site-settings", { data: {} }),
    );
    await expectApiForbidden(
      await apiPost(request, "store-manager", "/sp/plugin-users", {
        firstName: "Role",
        lastName: "Escalation",
        phone: `0912${Date.now().toString().slice(-7)}`,
        role: "Superadmin",
      }),
    );
    await expectApiForbidden(
      await apiPost(request, "store-manager", "/sp/local-users", {
        firstName: "Legacy",
        lastName: "Escalation",
        phone: `0912${Date.now().toString().slice(-7)}`,
        role: 1,
      }),
    );
    await expectApiForbidden(
      await apiPost(
        request,
        "customer",
        `/products/${productId}/variation-combinations`,
        {
          axes: [{ type: "color", termIds: [colorId] }],
        },
      ),
    );

    const publicWrite = await request.post(
      `${strapiApiURL().replace(/\/$/, "")}/products/${productId}/variation-combinations`,
      { data: { axes: [{ type: "color", termIds: [colorId] }] } },
    );
    await expectApiForbidden(publicWrite);

    await expectApiOk(
      await apiDelete(
        request,
        "store-manager",
        `/product-variations/${variationId}`,
      ),
      "Store manager transactional variation delete",
    );
    created.variations.splice(created.variations.indexOf(variationId), 1);
    const deletedStock = await apiGet(
      request,
      "admin",
      `/product-stocks/${stockId}`,
    );
    expect(deletedStock.status()).toBe(404);

    // Trash and restore are lifecycle commands with their own routes; the
    // generic update refuses the trash columns for every role.
    await expectApiOk(
      await apiPost(request, "store-manager", `/products/${productId}/soft-delete`, {}),
      "Store manager product soft delete",
    );
    await expectApiOk(
      await apiPost(request, "store-manager", `/products/${productId}/restore`, {}),
      "Store manager product restore",
    );
    await expectApiForbidden(
      await apiDelete(request, "store-manager", `/products/${productId}`),
    );
  });
});
