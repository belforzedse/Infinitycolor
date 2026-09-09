import { getAnipoBarcodeUi } from "../anipoBarcodeUi";

describe("getAnipoBarcodeUi", () => {
  it("treats a persisted barcode as issued regardless of stale workflow state", () => {
    expect(
      getAnipoBarcodeUi({ shippingBarcode: "123", state: "Pending" }),
    ).toMatchObject({ action: null, tone: "green" });
  });

  it("offers a status check instead of another submission while pending", () => {
    expect(getAnipoBarcodeUi({ state: "Pending" })).toMatchObject({
      action: "check",
      tone: "amber",
    });
  });

  it("offers manual re-check after automatic polling needs attention", () => {
    expect(getAnipoBarcodeUi({ state: "NeedsAttention" })).toMatchObject({
      action: "check",
      tone: "red",
    });
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
