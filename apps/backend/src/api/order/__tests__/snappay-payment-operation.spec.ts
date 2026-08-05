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

  it("blocks Store manager from raw payment-operation records", async () => {
    const paymentFind = jest.fn();
    const strapi = {
      db: {
        query: jest.fn((uid: string) =>
          uid === "plugin::users-permissions.user"
            ? {
                findOne: jest.fn().mockResolvedValue({
                  id: 7,
                  role: { name: "Store manager" },
                }),
              }
            : { findOne: paymentFind },
        ),
      },
    } as any;
    const ctx = {
      params: { id: "41", operationId: "91" },
      state: { user: { id: 7 } },
      badRequest: jest.fn(),
      forbidden: jest.fn(),
    } as any;

    await adminPaymentOperationHandler(strapi, ctx);

    expect(ctx.forbidden).toHaveBeenCalledWith("Admin access required");
    expect(paymentFind).not.toHaveBeenCalled();
  });
});
