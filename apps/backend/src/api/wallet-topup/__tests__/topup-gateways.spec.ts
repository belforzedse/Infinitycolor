import {
  initiateTopup,
  parseTopupCallback,
  verifyTopup,
} from "../services/topup-gateways";

const createStrapi = (services: Record<string, any>) =>
  ({
    service: jest.fn((uid: string) => services[uid]),
    config: { get: jest.fn((_key: string, fallback: string) => fallback) },
    log: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
  }) as any;

describe("wallet top-up gateway contracts", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, URL: "https://api.example.test" };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("uses a capital-T Token POST for Saman", async () => {
    const requestPayment = jest.fn().mockResolvedValue({
      success: true,
      token: "SEP-TOKEN-2",
      redirectUrl: "https://sep.shaparak.ir/OnlinePG/OnlinePG",
      status: 1,
    });
    const strapi = createStrapi({
      "api::payment-gateway.saman-kish": { requestPayment },
    });

    const result = await initiateTopup(strapi, {
      gateway: "SamanKish",
      saleOrderId: "1700000000001",
      amountIrr: 1_000_000,
    });

    expect(result).toEqual(
      expect.objectContaining({
        outcome: "redirect",
        redirectUrl: "https://sep.shaparak.ir/OnlinePG/OnlinePG",
        method: "POST",
        formFields: { Token: "SEP-TOKEN-2" },
      }),
    );
  });

  it("parses ZarinPal's GET callback authority and status", () => {
    expect(
      parseTopupCallback({
        query: { Authority: "A00000000000000000000000000000000001", Status: "OK" },
      }),
    ).toEqual({
      gateway: "ZarinPal",
      providerReference: "A00000000000000000000000000000000001",
      declaredSuccess: true,
      rawCode: "OK",
    });
  });

  it("refuses to confirm Saman without a positive exact settled amount", async () => {
    const reverseTransaction = jest.fn();
    const verifyTransaction = jest
      .fn()
      .mockResolvedValueOnce({ success: true, resultCode: "0", transactionDetail: {} })
      .mockResolvedValueOnce({
        success: true,
        resultCode: 0,
        transactionDetail: { affectiveamount: "999999" },
      });
    const strapi = createStrapi({
      "api::payment-gateway.saman-kish": { verifyTransaction, reverseTransaction },
    });

    await expect(
      verifyTopup(strapi, {
        gateway: "SamanKish",
        saleOrderId: "1700000000002",
        amountIrr: 1_000_000,
        providerReference: "REF-1",
      }),
    ).resolves.toMatchObject({ outcome: "unknown" });

    reverseTransaction.mockResolvedValue({ success: false, resultCode: -999 });
    await expect(
      verifyTopup(strapi, {
        gateway: "SamanKish",
        saleOrderId: "1700000000002",
        amountIrr: 1_000_000,
        providerReference: "REF-2",
      }),
    ).resolves.toMatchObject({ outcome: "unknown" });
  });

  it("fails an amount mismatch only after SEP confirms reversal", async () => {
    const strapi = createStrapi({
      "api::payment-gateway.saman-kish": {
        verifyTransaction: jest.fn().mockResolvedValue({
          success: true,
          resultCode: 0,
          transactionDetail: { OrginalAmount: "900000" },
        }),
        reverseTransaction: jest.fn().mockResolvedValue({ success: true, resultCode: "0" }),
      },
    });

    await expect(
      verifyTopup(strapi, {
        gateway: "SamanKish",
        saleOrderId: "1700000000003",
        amountIrr: 1_000_000,
        providerReference: "REF-3",
      }),
    ).resolves.toMatchObject({ outcome: "failed" });
  });
});
