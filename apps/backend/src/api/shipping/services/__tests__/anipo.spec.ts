import { parseAnipoBatchBarcodes, parseAnipoOrderResult } from "../anipo";

describe("Anipo order response parsing", () => {
  it("reads the nested full-order response without treating provider status as delivery", () => {
    expect(
      parseAnipoOrderResult({
        order: {
          order_code: "10",
          status: "issued",
          order_status: "در حال ارسال",
          ready_to_issue: true,
          issued: true,
          barcode: "POST-123",
          postal_cost: 125000,
          issued_at: "2026-08-11T09:15:00.000Z",
          weight_g: 700,
          service: "post",
        },
      }),
    ).toEqual({
      orderCode: "10",
      status: "issued",
      orderStatus: "در حال ارسال",
      readyToIssue: true,
      issued: true,
      barcode: "POST-123",
      barcodes: undefined,
      expectedCount: undefined,
      postalCost: 125000,
      issuedAt: "2026-08-11T09:15:00.000Z",
      weightG: 700,
      service: "post",
      message: undefined,
    });
  });

  it("accepts the direct barcode endpoint response shape", () => {
    expect(parseAnipoOrderResult({ issued: false, ready_to_issue: false })).toMatchObject({
      issued: false,
      readyToIssue: false,
    });
  });

  it("parses the observed batch envelope and keeps every parcel barcode", () => {
    expect(parseAnipoBatchBarcodes({ ok: true, data: [{
      order_code: "10", found: true, issued: true, barcode: "POST-1", count: 2,
      barcodes: [{ barcode: "POST-1" }, { barcode: "POST-2" }],
    }] })).toMatchObject([{ orderCode: "10", found: true, expectedCount: 2, barcodes: ["POST-1", "POST-2"] }]);
  });
});
