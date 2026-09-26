import { getAnipoBarcodeUi } from "../anipoBarcodeUi";

describe("getAnipoBarcodeUi", () => {
  it("keeps a partial barcode pending until all parcels are issued", () => {
    expect(
      getAnipoBarcodeUi({ shippingBarcode: "123", state: "Pending", submittedAt: "2026-09-26" }),
    ).toMatchObject({ action: "check", tone: "amber" });
  });

  it("offers a status check instead of another submission while pending", () => {
    expect(getAnipoBarcodeUi({ state: "Pending", submittedAt: "2026-09-26" })).toMatchObject({
      action: "check",
      tone: "amber",
    });
  });

  it("offers manual re-check after automatic polling needs attention", () => {
    expect(getAnipoBarcodeUi({ state: "NeedsAttention", submittedAt: "2026-09-20" })).toMatchObject({
      action: "check",
      tone: "red",
    });
  });

  it("offers registration retry for an unsubmitted or provider-missing order", () => {
    expect(getAnipoBarcodeUi({ state: "NeedsAttention" })).toMatchObject({ action: "submit", tone: "red" });
    expect(getAnipoBarcodeUi({ state: "NeedsAttention", submittedAt: "2026-09-20", lastError: "ANIPO_REMOTE_ORDER_NOT_FOUND" })).toMatchObject({ action: "submit", message: "سفارش در آنیپو پیدا نشد" });
  });

  it("refuses barcode submission while the reserve window is still open", () => {
    // The server rejects this with ANIPO_RESERVE_HOLD; the UI must not invite it.
    expect(
      getAnipoBarcodeUi({
        shippingMethodCode: "post",
        orderStatus: "Started",
        reserveIsHeld: true,
      }),
    ).toMatchObject({ action: null, tone: "amber" });
  });

  it("still reports an issued barcode on a held order rather than hiding it", () => {
    expect(
      getAnipoBarcodeUi({ shippingBarcode: "ANP-1", reserveIsHeld: true }),
    ).toMatchObject({ action: null, tone: "green", label: "بارکد صادر شده" });
  });

  it("allows submission again once the reserve window has closed", () => {
    expect(
      getAnipoBarcodeUi({
        shippingMethodCode: "post",
        orderStatus: "Started",
        reserveIsHeld: false,
      }),
    ).toMatchObject({ action: "submit" });
  });

  it("allows a new submission only for eligible future postal orders", () => {
    expect(
      getAnipoBarcodeUi({ shippingMethodCode: "post", orderStatus: "Started" }),
    ).toMatchObject({ action: "submit" });
    expect(
      getAnipoBarcodeUi({ shippingMethodCode: "pickup", orderStatus: "Started" }),
    ).toMatchObject({ action: null });
    expect(
      getAnipoBarcodeUi({ shippingMethodCode: "post", orderStatus: "Paying" }),
    ).toMatchObject({ action: null });
  });
});
