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
