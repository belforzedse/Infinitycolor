import { adminRevealSnappayTokenHandler } from "../controllers/helpers/adminSnappayToken";
import { recordAdminAudit } from "../../../utils/adminAudit";
import { decryptSnappaySecret } from "../../payment-gateway/services/snappay-security";

jest.mock("../../../utils/adminAudit", () => ({
  recordAdminAudit: jest.fn().mockResolvedValue(true),
}));
jest.mock("../../payment-gateway/services/snappay-security", () => ({
  decryptSnappaySecret: jest.fn().mockReturnValue("raw-snappay-token"),
  displaySnappayFingerprint: jest.fn().mockReturnValue("fingerprint"),
}));

const mockedAudit = recordAdminAudit as jest.MockedFunction<typeof recordAdminAudit>;
const mockedDecrypt = decryptSnappaySecret as jest.MockedFunction<typeof decryptSnappaySecret>;

function createHarness(role = "Superadmin", encrypted = true) {
  const queries: Record<string, any> = {
    "plugin::users-permissions.user": {
      findOne: jest.fn().mockResolvedValue({
        id: 7,
        role: { name: role },
      }),
    },
    "api::order.order": {
      findOne: jest.fn().mockResolvedValue({
        id: 22,
        PaymentGateway: "SnappPay",
        contract: { id: 33, external_source: "SnappPay" },
      }),
    },
    "api::payment-attempt.payment-attempt": {
      findOne: jest.fn().mockResolvedValue({
        id: 11,
        providerReference: "ABC1234567",
        providerStatus: "SETTLE",
      }),
    },
    "api::contract-transaction.contract-transaction": {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 44,
          external_source: "SnappPay",
          external_id: "ABC1234567",
          PaymentTokenCiphertext: encrypted ? "encrypted-token" : null,
          PaymentTokenHash: "full-fingerprint",
          TrackId: encrypted ? null : "legacy-token",
          GatewayStatus: "SETTLE",
        },
      ]),
    },
  };
  const strapi = {
    db: {
      query: jest.fn((uid: string) => queries[uid]),
    },
  } as any;
  const ctx = {
    params: { id: "22" },
    state: { user: { id: 7 } },
    request: { headers: {} },
    set: jest.fn(),
    badRequest: jest.fn(),
    forbidden: jest.fn((message: string) => ({ message })),
    notFound: jest.fn(),
    conflict: jest.fn(),
    internalServerError: jest.fn((message: string, payload: unknown) => ({
      message,
      payload,
    })),
  } as any;
  return { strapi, ctx, queries };
}

describe("SnappPay support-token reveal", () => {
  beforeEach(() => jest.clearAllMocks());

  it("decrypts only on an explicit admin request and audits without the token", async () => {
    const { strapi, ctx } = createHarness();

    const response = await adminRevealSnappayTokenHandler(strapi, ctx);

    expect(response).toEqual({
      data: {
        paymentToken: "raw-snappay-token",
        transactionId: "ABC1234567",
        providerStatus: "SETTLE",
        fingerprint: "fingerprint",
      },
    });
    expect(mockedDecrypt).toHaveBeenCalledWith("encrypted-token");
    expect(ctx.set).toHaveBeenCalledWith("Cache-Control", "no-store, private");
    expect(mockedAudit).toHaveBeenCalledWith(
      strapi,
      expect.objectContaining({
        resourceType: "Order",
        resourceId: 22,
        metadata: expect.objectContaining({
          operation: "snappay_token_reveal",
          transactionId: "ABC1234567",
          storage: "encrypted",
        }),
      }),
    );
    expect(JSON.stringify(mockedAudit.mock.calls[0][1])).not.toContain("raw-snappay-token");
  });

  it("supports legacy SnappPay rows that still hold TrackId", async () => {
    const { strapi, ctx } = createHarness("Store manager", false);

    const response = await adminRevealSnappayTokenHandler(strapi, ctx);

    expect(response).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ paymentToken: "legacy-token" }),
      }),
    );
    expect(mockedDecrypt).not.toHaveBeenCalled();
    expect(mockedAudit).toHaveBeenCalledWith(
      strapi,
      expect.objectContaining({
        metadata: expect.objectContaining({
          storage: "legacy_plaintext",
        }),
      }),
    );
  });

  it("does not reveal tokens to non-operational roles", async () => {
    const { strapi, ctx } = createHarness("Customer");

    const response = await adminRevealSnappayTokenHandler(strapi, ctx);

    expect(ctx.forbidden).toHaveBeenCalledWith("Admin access required");
    expect(response).toEqual({ message: "Admin access required" });
    expect(mockedDecrypt).not.toHaveBeenCalled();
    expect(mockedAudit).not.toHaveBeenCalled();
  });

  it("fails closed before decrypting when the audit entry cannot be persisted", async () => {
    mockedAudit.mockResolvedValueOnce(false);
    const { strapi, ctx } = createHarness();

    const response = await adminRevealSnappayTokenHandler(strapi, ctx);

    expect(ctx.internalServerError).toHaveBeenCalledWith(
      "SnappPay token access could not be audited",
      { data: { error: "SNAPPAY_TOKEN_AUDIT_FAILED" } },
    );
    expect(response).toEqual({
      message: "SnappPay token access could not be audited",
      payload: { data: { error: "SNAPPAY_TOKEN_AUDIT_FAILED" } },
    });
    expect(mockedDecrypt).not.toHaveBeenCalled();
  });

  it("does not fall back to a stale transaction when the current attempt has another id", async () => {
    const { strapi, ctx, queries } = createHarness();
    queries["api::contract-transaction.contract-transaction"].findMany.mockResolvedValueOnce([
      {
        id: 43,
        external_source: "SnappPay",
        external_id: "OLD1234567",
        PaymentTokenCiphertext: "stale-encrypted-token",
        PaymentTokenHash: "stale-fingerprint",
        TrackId: null,
        GatewayStatus: "SETTLE",
      },
    ]);

    await adminRevealSnappayTokenHandler(strapi, ctx);

    expect(ctx.conflict).toHaveBeenCalledWith("SnappPay transaction was not found", {
      data: { error: "SNAPPAY_TRANSACTION_NOT_FOUND" },
    });
    expect(mockedAudit).not.toHaveBeenCalled();
    expect(mockedDecrypt).not.toHaveBeenCalled();
  });
});
