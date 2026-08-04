import { normalizeOrderForInvoice } from "./normalizeOrder";

describe("normalizeOrderForInvoice", () => {
  it("maps the current Strapi order schema onto the Factorchi invoice fields", () => {
    const result = normalizeOrderForInvoice({
      data: {
        id: 42,
        Date: "2026-07-27T08:30:00.000Z",
        PaymentGateway: "Unknown",
        user: {
          id: 7,
          phone: "09120000000",
          user_info: {
            id: 8,
            FirstName: "علی",
            LastName: "رضایی",
            NationalCode: "0012345678",
          },
        },
        delivery_address: {
          id: 9,
          FullAddress: "خیابان ولیعصر، پلاک ۱۰",
          PostalCode: "4912345678",
          shipping_city: {
            id: 10,
            Title: "گرگان",
            shipping_province: {
              id: 11,
              Title: "گلستان",
            },
          },
        },
        shipping: {
          id: 12,
          Name: "پست پیشتاز",
        },
        contract: {
          id: 13,
          Amount: 231000,
          contract_transactions: [
            {
              id: 1,
              Status: "Success",
              Date: "2026-07-27T08:31:00.000Z",
              GatewayRefId: "REF-42",
              payment_gateway: {
                id: 2,
                Title: "ZarinPal",
              },
            },
            {
              id: 2,
              Status: "Failed",
              Date: "2026-07-27T08:32:00.000Z",
              external_id: "FAILED-REF",
              payment_gateway: {
                id: 3,
                Title: "Mellat",
              },
            },
          ],
        },
        order_items: [
          {
            id: 14,
            Count: 2,
            PerAmount: 100000,
            ProductTitle: "پیراهن",
            ProductSKU: "SKU-10",
            product_color: { id: 15, Title: "قرمز" },
            product_size: { id: 16, Title: "XL" },
            product_variation_model: { id: 17, Title: "کلاسیک" },
          },
        ],
      },
    });

    expect(result).toMatchObject({
      id: "42",
      attributes: {
        paymentGateway: "ZarinPal",
        transactionId: "REF-42",
        gatewayTrackingCode: "REF-42",
        user: {
          data: {
            attributes: {
              Phone: "09120000000",
              user_info: {
                data: {
                  attributes: {
                    FirstName: "علی",
                    LastName: "رضایی",
                    NationalCode: "0012345678",
                  },
                },
              },
            },
          },
        },
        delivery_address: {
          data: {
            attributes: {
              FullAddress: "گلستان، گرگان، خیابان ولیعصر، پلاک ۱۰",
              PostalCode: "4912345678",
            },
          },
        },
        shipping: {
          data: {
            attributes: {
              Name: "پست پیشتاز",
            },
          },
        },
        order_items: {
          data: [
            {
              attributes: {
                Count: 2,
                PerAmount: 100000,
                ProductTitle: "پیراهن",
                ProductSKU: "SKU-10",
              },
            },
          ],
        },
      },
    });
  });

  it("keeps national-code-only profiles and variation-level attributes", () => {
    const result = normalizeOrderForInvoice({
      id: 77,
      user: {
        id: 7,
        phone: "09121111111",
        user_info: {
          id: 8,
          NationalCode: "0098765432",
        },
      },
      order_items: [
        {
          id: 9,
          Count: 1,
          PerAmount: 50000,
          ProductTitle: "شلوار",
          ProductSKU: "SKU-77",
          product_variation: {
            id: 10,
            product_variation_color: { id: 11, Title: "آبی" },
            product_variation_size: { id: 12, Title: "۳۲" },
            product_variation_model: { id: 13, Title: "راسته" },
          },
        },
      ],
    });

    expect(result?.attributes.user.data.attributes.user_info.data.attributes.NationalCode).toBe(
      "0098765432",
    );
    expect(result?.attributes.order_items.data[0].attributes).toMatchObject({
      product_color: { data: { attributes: { Title: "آبی" } } },
      product_size: { data: { attributes: { Title: "۳۲" } } },
      product_variation_model: { data: { attributes: { Title: "راسته" } } },
    });
  });

  it.each([
    {
      gateway: "ZarinPal",
      transaction: {
        Status: "Success",
        GatewayAuthority: "ZP-AUTHORITY-NOT-A-RECEIPT",
        TrackId: "ZP-AUTHORITY-NOT-A-RECEIPT",
        GatewayRefId: "ZP-RECEIPT-42",
        external_id: "ZP-FINAL-42",
        external_source: "ZarinPal",
      },
      expectedReference: "ZP-RECEIPT-42",
    },
    {
      gateway: "Mellat",
      transaction: {
        Status: "Success",
        TrackId: "MELLAT-INITIAL-REFID",
        external_id: "MELLAT-SALE-REFERENCE-42",
        external_source: "Mellat",
      },
      expectedReference: "MELLAT-SALE-REFERENCE-42",
    },
    {
      gateway: "SamanKish",
      transaction: {
        Status: "Success",
        TrackId: "SAMAN-REFNUM-42",
        external_id: "SAMAN-MERCHANT-RESNUM-42",
        external_source: "SamanKish",
      },
      expectedReference: "SAMAN-REFNUM-42",
    },
    {
      gateway: "SnappPay",
      transaction: {
        Status: "Success",
        TrackId: "SNAPPAY-PAYMENT-TOKEN-MUST-NOT-PRINT",
        external_id: "SNAPPAY-TRANSACTION-42",
        external_source: "SnappPay",
      },
      expectedReference: "SNAPPAY-TRANSACTION-42",
    },
    {
      gateway: "Wallet",
      transaction: {
        Status: "Success",
        TrackId: "wallet-order-42-attempt-42",
        external_id: "wallet-order-42-attempt-42",
        external_source: "Wallet",
      },
      expectedReference: "wallet-order-42-attempt-42",
    },
  ])(
    "uses the final $gateway settlement reference instead of its initiation data",
    ({ gateway, transaction, expectedReference }) => {
      const result = normalizeOrderForInvoice({
        id: 42,
        Status: "Started",
        PaymentGateway: gateway,
        contract: {
          id: 13,
          contract_transactions: [
            {
              id: 1,
              Date: "2026-07-27T08:31:00.000Z",
              ...transaction,
            },
          ],
        },
      });

      expect(result?.attributes).toMatchObject({
        paymentGateway: gateway,
        transactionId: expectedReference,
        gatewayTrackingCode: expectedReference,
      });
      if (gateway === "SnappPay") {
        expect(JSON.stringify(result)).not.toContain("SNAPPAY-PAYMENT-TOKEN-MUST-NOT-PRINT");
      }
    },
  );

  it("keeps the successful gateway authoritative over a later failed attempt", () => {
    const result = normalizeOrderForInvoice({
      id: 42,
      Status: "Started",
      PaymentGateway: "Mellat",
      contract: {
        id: 13,
        contract_transactions: [
          {
            id: 1,
            Status: "Success",
            Date: "2026-07-27T08:31:00.000Z",
            GatewayRefId: "ZP-PAID-42",
            external_source: "ZarinPal",
          },
          {
            id: 2,
            Status: "Failed",
            Date: "2026-07-27T08:32:00.000Z",
            TrackId: "MELLAT-FAILED-INITIATION",
            external_source: "Mellat",
          },
        ],
      },
    });

    expect(result?.attributes).toMatchObject({
      paymentGateway: "ZarinPal",
      transactionId: "ZP-PAID-42",
      gatewayTrackingCode: "ZP-PAID-42",
    });
  });

  it("does not mistake a later return transaction for the original gateway payment", () => {
    const result = normalizeOrderForInvoice({
      id: 42,
      Status: "Returned",
      PaymentGateway: "Unknown",
      contract: {
        id: 13,
        contract_transactions: [
          {
            id: 1,
            Type: "Gateway",
            Status: "Success",
            Date: "2026-07-27T08:31:00.000Z",
            external_id: "MELLAT-SALE-REFERENCE-42",
            external_source: "Mellat",
          },
          {
            id: 2,
            Type: "Return",
            Status: "Success",
            Date: "2026-07-28T08:31:00.000Z",
            TrackId: "RETURN-42",
          },
        ],
      },
    });

    expect(result?.attributes).toMatchObject({
      paymentGateway: "Mellat",
      transactionId: "MELLAT-SALE-REFERENCE-42",
      gatewayTrackingCode: "MELLAT-SALE-REFERENCE-42",
    });
  });

  it("does not print pending gateway authorities or payment tokens as transaction receipts", () => {
    const result = normalizeOrderForInvoice({
      id: 42,
      Status: "Paying",
      PaymentGateway: "SnappPay",
      contract: {
        id: 13,
        external_id: "SNAPPAY-TRANSACTION-42",
        contract_transactions: [
          {
            id: 1,
            Status: "Pending",
            TrackId: "SNAPPAY-PAYMENT-TOKEN-MUST-NOT-PRINT",
            external_id: "SNAPPAY-TRANSACTION-42",
            external_source: "SnappPay",
          },
        ],
      },
    });

    expect(result?.attributes).toMatchObject({
      paymentGateway: "SnappPay",
    });
    expect(result?.attributes.transactionId).toBeUndefined();
    expect(result?.attributes.gatewayTrackingCode).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("SNAPPAY-PAYMENT-TOKEN-MUST-NOT-PRINT");
  });
});
