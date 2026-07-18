import { expect, test } from "@playwright/test";
import { authStorageStatePath } from "../../helpers/auth";
import { apiDelete, apiGet, apiPut, expectApiForbidden, expectApiOk } from "../../helpers/api";
import { expectForbiddenForRole } from "../../helpers/admin";
import { strapiApiURL } from "../../helpers/env";

/**
 * Regression coverage for the BOLA fixes on local-user-address and
 * local-user-wallet-transaction, plus the payment-gateway test-* lockdown.
 *
 * The content-API grant table only answers "can this role call this action at
 * all" - it has no concept of row ownership, so before the fix any Customer
 * could read/modify another Customer's address or wallet transaction by id.
 * These ids are discovered live (via Customer B's own API) rather than
 * hardcoded, since seeded ids are not otherwise exposed to tests.
 */
test.describe("cross-user ownership enforcement", () => {
  test.beforeEach(async ({}, testInfo) => {
    testInfo.skip(
      testInfo.project.name.includes("mobile"),
      "Permission API coverage is desktop-only.",
    );
  });

  test.describe("Customer vs Customer B", () => {
    test.use({ storageState: authStorageStatePath("customer") });

    test("@permissions Customer cannot read, update, or delete another customer's address", async ({
      request,
    }) => {
      const ownAddresses = await apiGet(request, "customer-b", "/local-user-addresses");
      await expectApiOk(ownAddresses, "Customer B addresses");
      const ownAddressPayload = (await ownAddresses.json()) as { data?: Array<{ id: number }> };
      const addressId = ownAddressPayload.data?.[0]?.id;
      expect(addressId, "Customer B must own at least one seeded address").toBeTruthy();

      const readResponse = await apiGet(request, "customer", `/local-user-addresses/${addressId}`);
      expect(readResponse.status()).toBe(404);

      const updateResponse = await apiPut(request, "customer", `/local-user-addresses/${addressId}`, {
        data: { Description: "should not be applied" },
      });
      expect(updateResponse.status()).toBe(404);

      const deleteResponse = await apiDelete(request, "customer", `/local-user-addresses/${addressId}`);
      expect(deleteResponse.status()).toBe(404);

      const ownList = await apiGet(request, "customer", "/local-user-addresses");
      await expectApiOk(ownList, "Customer own addresses");
      const ownListPayload = (await ownList.json()) as { data?: Array<{ id: number }> };
      expect(ownListPayload.data?.map((row) => row.id)).not.toContain(addressId);
    });

    test("@permissions Customer cannot read another customer's wallet transaction", async ({
      request,
    }) => {
      const ownTransactions = await apiGet(request, "customer-b", "/local-user-wallet-transactions");
      await expectApiOk(ownTransactions, "Customer B wallet transactions");
      const ownTransactionsPayload = (await ownTransactions.json()) as {
        data?: Array<{ id: number }>;
      };
      const transactionId = ownTransactionsPayload.data?.[0]?.id;
      expect(transactionId, "Customer B must own at least one seeded wallet transaction").toBeTruthy();

      const readResponse = await apiGet(
        request,
        "customer",
        `/local-user-wallet-transactions/${transactionId}`,
      );
      expect(readResponse.status()).toBe(404);

      const ownList = await apiGet(request, "customer", "/local-user-wallet-transactions");
      await expectApiOk(ownList, "Customer own wallet transactions");
      const ownListPayload = (await ownList.json()) as { data?: Array<{ id: number }> };
      expect(ownListPayload.data?.map((row) => row.id)).not.toContain(transactionId);
    });
  });

  test.describe("payment-gateway test endpoints", () => {
    test("@permissions unauthenticated requests cannot reach the live gateway test endpoint", async ({
      request,
    }) => {
      const response = await request.post(`${strapiApiURL()}/payment-gateway/test-mellat`, {
        headers: { Accept: "application/json" },
        data: {},
      });
      await expectApiForbidden(response);
    });

    test.use({ storageState: authStorageStatePath("customer") });

    test("@permissions a Customer cannot reach the live gateway test endpoint", async ({ request }) => {
      await expectForbiddenForRole(request, "customer", "post", "/payment-gateway/test-mellat", {});
    });
  });
});
