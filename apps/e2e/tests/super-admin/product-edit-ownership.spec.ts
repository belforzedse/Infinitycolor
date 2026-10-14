import {
  expect,
  test,
  type BrowserContext,
  type Route,
} from "@playwright/test";
import {
  assertNonProductionTarget,
  seededCategoryId,
} from "../../helpers/admin";
import { apiGet, apiPost, authHeaders, expectApiOk } from "../../helpers/api";
import { authStorageStatePath } from "../../helpers/auth";
import { adminBaseURL, strapiApiURL } from "../../helpers/env";

// The deterministic mode exercises the real admin UI with two isolated mocked
// staff identities. It is UI/transport evidence, not PostgreSQL lease evidence.
// E2E_PRODUCT_EDIT_REAL=1 additionally runs the real authenticated API journey.
const MOCK_ID = 424242;
const caps = [
  "product.read",
  "product.update",
  "product.variation.manage",
  "product.variation.delete",
  "product.size-guide.manage",
  "product.homepage.manage",
  "product.stock.update",
];
type Proof = {
  token: string;
  editorInstanceId: string;
  generation: number;
  expiresAt: string;
  serverNow: string;
};

function product(title = "محصول آزمایشی") {
  return {
    id: MOCK_ID,
    attributes: {
      Title: title,
      Slug: "ownership-fixture",
      Description: "",
      Status: "InActive",
      ProductType: "Variable",
      IsSimpleProduct: false,
      Files: { data: [] },
      Media: { data: [] },
      CoverImage: { data: null },
      product_main_category: { data: null },
      product_other_categories: { data: [] },
      product_tags: { data: [] },
      product_size_helper: {
        data: {
          id: 91,
          attributes: {
            Helper: [
              ["سایز", "قد"],
              ["S", "50"],
            ],
          },
        },
      },
      product_variations: {
        data: [
          {
            id: 71,
            attributes: {
              SKU: "TEST-S",
              Price: 100,
              IsPublished: true,
              product: { data: { id: MOCK_ID } },
              product_variation_size: {
                data: { id: 81, attributes: { Title: "S" } },
              },
              product_stock: {
                data: { id: 82, attributes: { Count: 5, StockRevision: 3 } },
              },
              general_discounts: { data: [] },
              selected_attribute_terms: { data: [] },
            },
          },
        ],
      },
    },
  };
}

async function mockStaff(
  context: BrowserContext,
  staffId: number,
  backend: {
    owner: number | null;
    proof: Proof | null;
    generation: number;
    revision: number;
    acquisitionCalls: number;
    takeoverExpectedGenerations: number[];
    releaseAttempts: number;
    offlineStaffIds: Set<number>;
    saved: ReturnType<typeof product>;
    writes: Array<{
      staffId: number;
      body: unknown;
      headers: Record<string, string>;
    }>;
  },
) {
  await context.addCookies([
    {
      name: "infinity_admin_route_hint",
      value: "1",
      url: adminBaseURL(),
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await context.route(
    /\/api\/(?:backend\/)?(?:auth\/(?:token|self)|users\/me|products|product-|settings)/,
    async (route: Route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace(
        /^\/api\/(?:backend\/)?/,
        "/",
      );
      const headers = {
        "access-control-allow-origin": request.headers().origin || "*",
        "access-control-allow-credentials": "true",
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      };
      const json = (body: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          headers,
          body: JSON.stringify(body),
        });
      if (request.method() === "OPTIONS") return json({});
      if (path === "/auth/token") {
        const payload = Buffer.from(
          JSON.stringify({
            sub: String(staffId),
            exp: Math.floor(Date.now() / 1000) + 7200,
          }),
        ).toString("base64url");
        return json({ token: `mock.${payload}.mock` });
      }
      if (path === "/users/me" || path === "/auth/self")
        return json({
          data: {
            id: staffId,
            isAdmin: true,
            adminRole: "store_manager",
            FirstName: `همکار ${staffId}`,
            LastName: "آزمایشی",
            capabilities: caps,
          },
        });
      if (path === `/products/${MOCK_ID}/edit-snapshot`)
        return json({
          data: { product: backend.saved, revision: backend.revision },
        });
      if (path === `/products/${MOCK_ID}/edit-lease`)
        return json({
          data: {
            owner: backend.owner
              ? { id: backend.owner, label: `همکار ${backend.owner}` }
              : null,
            generation: backend.generation,
            expiresAt: backend.proof?.expiresAt ?? null,
            serverNow: new Date().toISOString(),
            owned: backend.owner === staffId,
            leaseSeconds: 90,
            heartbeatSeconds: 30,
            pollSeconds: 10,
          },
        });
      if (
        path.endsWith("/edit-lease/acquire") ||
        path.endsWith("/edit-lease/takeover")
      ) {
        backend.acquisitionCalls += 1;
        const input = request.postDataJSON();
        if (path.endsWith("takeover"))
          backend.takeoverExpectedGenerations.push(input.expectedGeneration);
        if (backend.owner && !path.endsWith("takeover"))
          return json(
            {
              error: {
                status: 409,
                message: "busy",
                details: { code: "EDIT_LEASE_CONFLICT" },
              },
            },
            409,
          );
        if (
          path.endsWith("takeover") &&
          input.expectedGeneration !== backend.generation
        )
          return json(
            {
              error: {
                status: 409,
                message: "changed",
                details: { code: "EDIT_LEASE_CONFLICT" },
              },
            },
            409,
          );
        backend.owner = staffId;
        backend.generation += 1;
        backend.proof = {
          token: `memory-only-${staffId}-${backend.generation}`,
          editorInstanceId: input.editorInstanceId,
          generation: backend.generation,
          expiresAt: new Date(Date.now() + 90_000).toISOString(),
          serverNow: new Date().toISOString(),
        };
        return json({
          data: {
            lease: backend.proof,
            snapshot: { product: backend.saved, revision: backend.revision },
          },
        });
      }
      if (path.endsWith("/editor") && backend.offlineStaffIds.has(staffId))
        return route.abort("internetdisconnected");
      if (
        path.endsWith("/edit-lease/renew") ||
        path.endsWith("/edit-lease/release") ||
        path.endsWith("/editor")
      ) {
        const proof = request.headers();
        if (
          backend.owner !== staffId ||
          proof["x-product-edit-token"] !== backend.proof?.token ||
          proof["x-product-edit-generation"] !== String(backend.generation)
        ) {
          return json(
            {
              error: {
                status: 409,
                message: "ownership lost",
                details: { code: "EDIT_LEASE_LOST" },
              },
            },
            409,
          );
        }
        if (path.endsWith("release")) {
          backend.releaseAttempts += 1;
          backend.owner = null;
          backend.proof = null;
          return json({ data: { released: true } });
        }
        if (path.endsWith("renew"))
          return json({
            data: {
              lease: {
                ...backend.proof,
                expiresAt: new Date(Date.now() + 90_000).toISOString(),
                serverNow: new Date().toISOString(),
              },
            },
          });
        backend.writes.push({
          staffId,
          body: request.postDataJSON(),
          headers: proof,
        });
        if (Number(proof["x-product-expected-revision"]) !== backend.revision)
          return json(
            {
              error: {
                status: 409,
                message: "changed",
                details: { code: "PRODUCT_VERSION_CONFLICT" },
              },
            },
            409,
          );
        backend.saved = product(request.postDataJSON().data.Title);
        backend.revision += 1;
        return json({
          data: { product: backend.saved, revision: backend.revision },
          meta: { editRevision: backend.revision },
        });
      }
      if (path === "/settings/homepage-products")
        return json({
          data: {
            id: 1,
            attributes: {
              homeNewestProductIds: [],
              homeFavoriteProductIds: [],
              homeDiscountedProductIds: [],
              HomepageProductsRevision: 1,
            },
          },
        });
      if (path.startsWith("/product-variations"))
        return json({ data: backend.saved.attributes.product_variations.data });
      if (path.startsWith("/products")) return json({ data: [backend.saved] });
      return json({
        data: [],
        meta: {
          pagination: { page: 1, pageSize: 100, pageCount: 0, total: 0 },
        },
      });
    },
  );
}

test("@admin @mock product takeover freezes the previous editor and retains all tab drafts", async ({
  browser,
}, testInfo) => {
  test.skip(
    testInfo.project.name.includes("mobile"),
    "Ownership transport test runs on desktop.",
  );
  test.skip(
    process.env.E2E_PRODUCT_EDIT_REAL === "1",
    "Use the real authenticated journey in this mode.",
  );
  const backend = {
    owner: null as number | null,
    proof: null as Proof | null,
    generation: 0,
    revision: 1,
    acquisitionCalls: 0,
    takeoverExpectedGenerations: [] as number[],
    releaseAttempts: 0,
    offlineStaffIds: new Set<number>(),
    saved: product(),
    writes: [] as Array<{
      staffId: number;
      body: unknown;
      headers: Record<string, string>;
    }>,
  };
  const first = await browser.newContext({
    baseURL: adminBaseURL(),
    locale: "fa-IR",
    serviceWorkers: "block",
  });
  const second = await browser.newContext({
    baseURL: adminBaseURL(),
    locale: "fa-IR",
    serviceWorkers: "block",
  });
  try {
    await mockStaff(first, 101, backend);
    await mockStaff(second, 102, backend);
    const a = await first.newPage();
    const b = await second.newPage();
    await a.clock.install();
    await b.clock.install();
    await a.goto(`/products/${MOCK_ID}`);
    await expect(a.getByTestId("product-editor-status")).toContainText(
      "ویرایش در اختیار شماست",
    );
    await a.locator('input[name="name"]').fill("عنوان ذخیره‌نشده");
    const oldProof = { ...backend.proof! };
    await a.getByRole("tab", { name: "راهنمای سایز", exact: true }).click();
    await a.getByRole("button", { name: "ویرایش راهنما", exact: true }).click();
    await a.locator('input[value="50"]').fill("55");
    await a.getByRole("tab", { name: "متغیرها", exact: true }).click();
    await a
      .getByRole("button", { name: "ویرایش", exact: true })
      .first()
      .click();
    await a
      .getByRole("dialog")
      .locator('input[type="text"]')
      .last()
      .fill("DRAFT-SKU");

    await b.goto(`/products/${MOCK_ID}`);
    await expect(b.getByRole("dialog")).toContainText("همکار 101");
    await b
      .getByRole("button", { name: "مشاهده بدون ویرایش", exact: true })
      .click();
    await expect(b.getByTestId("admin-product-save")).toBeDisabled();
    await expect(b.locator('input[name="name"]')).toBeDisabled();
    await b.getByRole("button", { name: "شروع ویرایش", exact: true }).click();
    // The confirmation remains bound to owner 101 / generation 1 even when a
    // status poll sees that another staff member took over in the meantime.
    backend.owner = 103;
    backend.generation += 1;
    await b.clock.fastForward(10_000);
    await expect(b.getByRole("dialog")).toContainText("همکار 101");
    await b
      .getByRole("button", { name: "گرفتن دسترسی ویرایش", exact: true })
      .click();
    await expect(b.getByRole("dialog")).toContainText("همکار 103");
    expect(backend.takeoverExpectedGenerations).toEqual([1]);
    expect(backend.owner).toBe(103);

    // The stale attempt reports the current owner and waits for a second
    // deliberate confirmation using the refreshed generation.
    await b
      .getByRole("button", { name: "گرفتن دسترسی ویرایش", exact: true })
      .click();
    expect(backend.takeoverExpectedGenerations).toEqual([1, 2]);
    await expect(b.getByTestId("admin-product-save")).toBeEnabled();
    await expect(b.locator('input[name="name"]')).toHaveValue("محصول آزمایشی");
    await b.locator('input[name="name"]').fill("عنوان همکار دوم");
    await b.getByTestId("admin-product-save").click();
    await expect
      .poll(() => backend.saved.attributes.Title)
      .toBe("عنوان همکار دوم");

    await a.clock.fastForward(31_000);
    await expect(a.getByTestId("admin-product-save")).toBeDisabled();
    await expect(
      a.getByRole("dialog").locator('input[type="text"]').last(),
    ).toHaveValue("DRAFT-SKU");
    await expect(
      a.getByRole("dialog").locator('input[type="text"]').last(),
    ).toBeDisabled();
    await a.getByRole("button", { name: "بستن", exact: true }).click();
    await a.getByRole("tab", { name: "کلی", exact: true }).click();
    await expect(a.locator('input[name="name"]')).toHaveValue(
      "عنوان ذخیره‌نشده",
    );
    await a.getByRole("tab", { name: "راهنمای سایز", exact: true }).click();
    await expect(a.locator('input[value="55"]')).toBeDisabled();
    await a.getByRole("tab", { name: "متغیرها", exact: true }).click();
    await expect(
      a.getByRole("button", { name: "ویرایش گروهی", exact: true }),
    ).toBeDisabled();
    const stale = await a.evaluate(
      async ({ id, proof }) => {
        const response = await fetch(
          `/api/backend/products/${id}/editor`,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              "X-Product-Edit-Token": proof.token,
              "X-Product-Edit-Instance": proof.editorInstanceId,
              "X-Product-Edit-Generation": String(proof.generation),
              "X-Product-Expected-Revision": "1",
            },
            body: JSON.stringify({ data: { Title: "stale write" } }),
          },
        );
        return response.status;
      },
      { id: MOCK_ID, proof: oldProof },
    );
    expect(stale).toBe(409);
    expect(backend.saved.attributes.Title).toBe("عنوان همکار دوم");
    expect(backend.writes).toHaveLength(1);

    // A fresh editor instance observes the current owner and stays read-only;
    // loading the page must never promote itself without an explicit action.
    const acquisitionCallsBeforeRefresh = backend.acquisitionCalls;
    a.on("dialog", (dialog) => void dialog.accept());
    await a.reload();
    await expect(a.getByRole("dialog")).toContainText("همکار 102");
    await expect(a.getByTestId("admin-product-save")).toBeDisabled();
    expect(backend.owner).toBe(102);
    expect(backend.acquisitionCalls).toBe(acquisitionCallsBeforeRefresh);

    // A failed write while offline freezes the owner but leaves its tab draft
    // visible for recovery. It must not reach or overwrite the shared snapshot.
    await b.locator('input[name="name"]').fill("پیش‌نویس آفلاین");
    backend.offlineStaffIds.add(102);
    await second.setOffline(true);
    await b.getByTestId("admin-product-save").click();
    await expect(b.getByTestId("admin-product-save")).toBeDisabled();
    await expect(b.locator('input[name="name"]')).toHaveValue(
      "پیش‌نویس آفلاین",
    );
    expect(backend.saved.attributes.Title).toBe("عنوان همکار دوم");
    expect(backend.writes).toHaveLength(1);
    await second.setOffline(false);
    backend.offlineStaffIds.delete(102);

    // The pagehide cleanup makes a best-effort release on navigation.
    const releasesBeforeNavigation = backend.releaseAttempts;
    b.on("dialog", (dialog) => void dialog.accept());
    await b.goto("/products");
    await expect
      .poll(() => backend.releaseAttempts)
      .toBeGreaterThan(releasesBeforeNavigation);
    expect(backend.owner).toBeNull();
    for (const page of [a, b]) {
      const stored = await page.evaluate(() =>
        JSON.stringify({
          local: { ...localStorage },
          session: { ...sessionStorage },
        }),
      );
      expect(stored).not.toContain("memory-only-");
      expect(stored).not.toContain("X-Product-Edit-Token");
    }
  } finally {
    await first.close();
    await second.close();
  }
});

test("@admin @real independent staff ownership rejects a stale authenticated save", async ({
  browser,
  request,
}, testInfo) => {
  test.skip(
    process.env.E2E_PRODUCT_EDIT_REAL !== "1",
    "Requires isolated PostgreSQL/backend/auth runtime and seeded staff storage states.",
  );
  test.skip(
    testInfo.project.name.includes("mobile"),
    "Ownership journey runs on desktop.",
  );
  assertNonProductionTarget();
  const identities = await Promise.all(
    ["admin", "store-manager"].map(async (role) => {
      const response = await apiGet(
        request,
        role as "admin" | "store-manager",
        "/auth/self",
      );
      await expectApiOk(response, `read ${role} identity`);
      const payload = await response.json();
      return payload.data?.id ?? payload.id;
    }),
  );
  expect(identities[0]).toBeTruthy();
  expect(identities[1]).toBeTruthy();
  expect(identities[0]).not.toBe(identities[1]);
  const categoryId = await seededCategoryId(request);
  const create = await apiPost(request, "admin", "/products", {
    data: {
      Title: `E2E ownership ${Date.now()}`,
      ProductType: "Simple",
      IsSimpleProduct: true,
      product_main_category: categoryId,
    },
  });
  await expectApiOk(create, "create isolated ownership fixture");
  const {
    data: { id },
  } = (await create.json()) as { data: { id: number } };
  const first = await browser.newContext({
    baseURL: adminBaseURL(),
    storageState: authStorageStatePath("admin"),
    serviceWorkers: "block",
  });
  const second = await browser.newContext({
    baseURL: adminBaseURL(),
    storageState: authStorageStatePath("store-manager"),
    serviceWorkers: "block",
  });
  let cleanupProof: { role: "admin" | "store-manager"; lease: Proof } | null =
    null;
  try {
    const a = await first.newPage();
    const b = await second.newPage();
    await a.clock.install();
    const acquisition = a.waitForResponse(
      (response) =>
        response.url().endsWith(`/products/${id}/edit-lease/acquire`) &&
        response.ok(),
    );
    await a.goto(`/products/${id}`);
    const {
      data: { lease, snapshot },
    } = (await (await acquisition).json()) as {
      data: { lease: Proof; snapshot: { revision: number } };
    };
    cleanupProof = { role: "admin", lease };
    await a.locator('input[name="name"]').fill("تغییرات همکار اول");
    await b.goto(`/products/${id}`);
    await expect(b.getByRole("dialog")).toContainText(
      "این محصول در حال ویرایش است",
    );
    await b
      .getByRole("button", { name: "مشاهده بدون ویرایش", exact: true })
      .click();
    await expect(b.getByTestId("admin-product-save")).toBeDisabled();
    await b.getByRole("button", { name: "شروع ویرایش", exact: true }).click();
    const takeover = b.waitForResponse(
      (response) =>
        response.url().endsWith(`/products/${id}/edit-lease/takeover`) &&
        response.ok(),
    );
    await b
      .getByRole("button", { name: "گرفتن دسترسی ویرایش", exact: true })
      .click();
    const takeoverPayload = (await (await takeover).json()) as {
      data: { lease: Proof };
    };
    cleanupProof = { role: "store-manager", lease: takeoverPayload.data.lease };
    await expect(b.getByTestId("admin-product-save")).toBeEnabled();
    const stale = await request.put(`${strapiApiURL()}/products/${id}/editor`, {
      headers: {
        ...(await authHeaders("admin")),
        "X-Product-Edit-Token": lease.token,
        "X-Product-Edit-Instance": lease.editorInstanceId,
        "X-Product-Edit-Generation": String(lease.generation),
        "X-Product-Expected-Revision": String(snapshot.revision),
      },
      data: { data: { Title: "stale authenticated write" } },
    });
    expect(stale.status()).toBe(409);
    const payload = await stale.json();
    expect(payload.error?.details?.code).toBe("EDIT_LEASE_LOST");
    await a.clock.fastForward(11_000);
    await expect(a.getByTestId("admin-product-save")).toBeDisabled();
    await expect(a.locator('input[name="name"]')).toHaveValue(
      "تغییرات همکار اول",
    );
  } finally {
    if (cleanupProof) {
      const { lease, role } = cleanupProof;
      const released = await request.post(
        `${strapiApiURL()}/products/${id}/edit-lease/release`,
        {
          headers: {
            ...(await authHeaders(role)),
            "X-Product-Edit-Token": lease.token,
            "X-Product-Edit-Instance": lease.editorInstanceId,
            "X-Product-Edit-Generation": String(lease.generation),
          },
          data: {},
        },
      );
      expect([200, 409]).toContain(released.status());
    }
    await first.close();
    await second.close();
    const trash = await apiPost(request, "admin", "/products/lifecycle/bulk", {
      data: { action: "trash", ids: [id] },
    });
    await expectApiOk(trash, "trash ownership fixture");
    expect((await trash.json()).data.failed).toEqual([]);
    const purge = await apiPost(request, "admin", "/products/lifecycle/bulk", {
      data: { action: "purge", ids: [id] },
    });
    await expectApiOk(purge, "purge ownership fixture");
    expect((await purge.json()).data.failed).toEqual([]);
  }
});
