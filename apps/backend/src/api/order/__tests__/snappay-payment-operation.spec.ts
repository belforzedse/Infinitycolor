import { adminPaymentOperationHandler } from "../controllers/helpers/adminPaymentOperation";

describe("SnappPay admin payment-operation status", () => {
  it("returns separate HTTP and provider diagnostics to Superadmin", async () => {
    const queries: Record<string, any> = {
      "plugin::users-permissions.user": {
        findOne: jest.fn().mockResolvedValue({
          id: 7,
          role: { name: "Superadmin" },
        }),
      },
      "api::payment-operation.payment-operation": {
        findOne: jest.fn().mockResolvedValue({
          id: 91,
          OperationType: "UPDATE",
          Status: "Failed",
          providerStatus: "SETTLE",
          httpStatus: 409,
          providerCode: 1042,
          retryCount: 0,
          nextRunAt: null,
          failureMessage: "SNAPPAY_UPDATE_1042:amount rejected",
          createdAt: "2026-07-27T09:00:00.000Z",
          updatedAt: "2026-07-27T09:00:01.000Z",
        }),
      },
    };
    const strapi = {
      query: jest.fn((uid: string) => queries[uid]),
      db: {
        query: jest.fn((uid: string) => queries[uid]),
      },
    } as any;
    const ctx = {
      params: { id: "41", operationId: "91" },
      state: { user: { id: 7 } },
      badRequest: jest.fn(),
      forbidden: jest.fn(),
      notFound: jest.fn(),
    } as any;

    await expect(adminPaymentOperationHandler(strapi, ctx)).resolves.toEqual({
      data: {
        id: 91,
        operationType: "UPDATE",
        status: "Failed",
        providerStatus: "SETTLE",
        httpStatus: 409,
        providerCode: 1042,
        retryCount: 0,
        nextRunAt: null,
        failureMessage: "SNAPPAY_UPDATE_1042:amount rejected",
        createdAt: "2026-07-27T09:00:00.000Z",
        updatedAt: "2026-07-27T09:00:01.000Z",
      },
    });
  });

  const operationStrapi = (roleName: string, operation: any) => {
    const paymentFind = jest.fn().mockResolvedValue(operation);
    const queries: Record<string, any> = {
      "plugin::users-permissions.user": {
        findOne: jest.fn().mockResolvedValue({ id: 7, role: { name: roleName } }),
      },
      "api::payment-operation.payment-operation": { findOne: paymentFind },
    };
    const strapi = {
      query: jest.fn((uid: string) => queries[uid]),
      db: { query: jest.fn((uid: string) => queries[uid]) },
    } as any;
    const ctx = {
      params: { id: "41", operationId: "91" },
      state: { user: { id: 7 } },
      badRequest: jest.fn(),
      forbidden: jest.fn(),
      notFound: jest.fn(),
    } as any;
    return { strapi, ctx, paymentFind };
  };

  it("reads every operation type with financial read", async () => {
    const { strapi, ctx, paymentFind } = operationStrapi("Finance", {
      id: 91,
      OperationType: "RECONCILE",
      Status: "Succeeded",
    });

    const result = await adminPaymentOperationHandler(strapi, ctx);

    expect(result?.data.operationType).toBe("RECONCILE");
    expect(paymentFind.mock.calls[0][0].where).toEqual({ id: 91, order: { id: 41 } });
  });

  it.each(["Seller 2", "Store Manager"])(
    "lets %s read back the SnappPay cancel it queued",
    async (roleName) => {
      const { strapi, ctx, paymentFind } = operationStrapi(roleName, {
        id: 91,
        OperationType: "CANCEL",
        Status: "Succeeded",
        providerStatus: "CANCEL",
      });

      const result = await adminPaymentOperationHandler(strapi, ctx);

      expect(ctx.forbidden).not.toHaveBeenCalled();
      expect(result?.data).toMatchObject({ operationType: "CANCEL", status: "Succeeded" });
      expect(paymentFind.mock.calls[0][0].where).toEqual({
        id: 91,
        order: { id: 41 },
        OperationType: { $in: ["CANCEL"] },
      });
    },
  );

  it("keeps other operation types hidden from cancel-only operators", async () => {
    // The type filter is in the query, so a non-CANCEL operation is simply not found.
    const { strapi, ctx } = operationStrapi("Store Manager", null);

    await adminPaymentOperationHandler(strapi, ctx);

    expect(ctx.notFound).toHaveBeenCalledWith("Payment operation not found");
    expect(ctx.forbidden).not.toHaveBeenCalled();
  });

  it("blocks roles that can neither cancel nor read financials", async () => {
    const { strapi, ctx, paymentFind } = operationStrapi("Seller 1", {
      id: 91,
      OperationType: "CANCEL",
    });

    await adminPaymentOperationHandler(strapi, ctx);

    expect(ctx.forbidden).toHaveBeenCalledWith(
      "You do not have permission to perform this action",
    );
    expect(paymentFind).not.toHaveBeenCalled();
  });
});
