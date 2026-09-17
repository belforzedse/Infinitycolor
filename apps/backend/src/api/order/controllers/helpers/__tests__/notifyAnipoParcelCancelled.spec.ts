import * as Sentry from "@sentry/node";
import {
  captureAnipoCancelSnapshot,
  notifyAnipoParcelCancelled,
  shouldNotifyAnipoParcelCancelled,
} from "../notifyAnipoParcelCancelled";

jest.mock("@sentry/node", () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

describe("notifyAnipoParcelCancelled", () => {
  const updateOrderStatus = jest.fn();
  const orderUpdate = jest.fn().mockResolvedValue({});

  function makeStrapi() {
    return {
      service: jest.fn(() => ({ updateOrderStatus })),
      db: {
        query: jest.fn(() => ({ update: orderUpdate })),
      },
      log: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
    } as any;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    updateOrderStatus.mockResolvedValue({ ok: true });
    orderUpdate.mockResolvedValue({});
  });

  it("skips when the order was never registered at Anipo", async () => {
    const strapi = makeStrapi();
    const snapshot = captureAnipoCancelSnapshot({
      ShippingBarcode: null,
      AnipoSubmittedAt: null,
      AnipoBarcodeState: "Voided",
    });

    expect(shouldNotifyAnipoParcelCancelled(snapshot)).toBe(false);
    await notifyAnipoParcelCancelled(strapi, 41, snapshot);

    expect(strapi.service).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("PUTs لغو شده when a shipping barcode was present", async () => {
    const strapi = makeStrapi();
    const snapshot = captureAnipoCancelSnapshot({
      ShippingBarcode: "ANIPO-1",
      AnipoBarcodeState: "Issued",
    });

    await notifyAnipoParcelCancelled(strapi, 41, snapshot);

    expect(updateOrderStatus).toHaveBeenCalledWith("41", "لغو شده");
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(orderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          AnipoLastMessage: "Anipo parcel marked cancelled (لغو شده)",
        }),
      }),
    );
  });

  it("notifies when AnipoSubmittedAt is set even without a barcode", async () => {
    const strapi = makeStrapi();
    await notifyAnipoParcelCancelled(
      strapi,
      99,
      captureAnipoCancelSnapshot({
        ShippingBarcode: null,
        AnipoSubmittedAt: "2026-09-01T00:00:00.000Z",
        AnipoBarcodeState: "Pending",
      }),
    );

    expect(updateOrderStatus).toHaveBeenCalledWith("99", "لغو شده");
  });

  it("reports Anipo { ok: false } to Sentry and never throws", async () => {
    updateOrderStatus.mockResolvedValue({ ok: false, error: "provider_refused" });
    const strapi = makeStrapi();

    await expect(
      notifyAnipoParcelCancelled(
        strapi,
        41,
        captureAnipoCancelSnapshot({ ShippingBarcode: "ANIPO-1" }),
      ),
    ).resolves.toBeUndefined();

    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      "anipo.parcel_cancel_failed",
      expect.objectContaining({
        level: "error",
        tags: { area: "shipping", provider: "anipo", stage: "cancel" },
        extra: { orderId: 41, error: "provider_refused" },
      }),
    );
    expect(orderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          AnipoLastMessage: expect.stringContaining("provider_refused"),
        }),
      }),
    );
  });

  it("reports thrown Anipo client errors to Sentry and never throws", async () => {
    updateOrderStatus.mockRejectedValue(new Error("network_down"));
    const strapi = makeStrapi();

    await expect(
      notifyAnipoParcelCancelled(
        strapi,
        7,
        captureAnipoCancelSnapshot({ AnipoBarcodeState: "Stopped" }),
      ),
    ).resolves.toBeUndefined();

    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      "anipo.parcel_cancel_failed",
      expect.objectContaining({
        extra: { orderId: 7, error: "network_down" },
      }),
    );
  });
});
