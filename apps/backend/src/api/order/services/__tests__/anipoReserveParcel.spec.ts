import {
  aggregateParcel,
  effectiveParcelState,
  parcelSummary,
  submitReserveParcel,
  refreshReserveParcel,
  reconcileReserveParcelCancellation,
  syncReserveParcelRecipient,
} from "../anipoReserveParcel";
import { claimGroupShippingBarcode } from "../../../reserve-group/lib/reserve-group";

jest.mock("../../../reserve-group/lib/reserve-group", () => ({
  HELD_RESERVE_STATES: ["PendingActivation", "Active"],
  claimGroupShippingBarcode: jest.fn().mockResolvedValue({ claimed: true, ordersStamped: 2 }),
}));
jest.mock("../../../../utils/adminActivity", () => ({ logAdminBarcodeOperation: jest.fn() }));

const group = () => ({
  id: 9,
  groupKey: "parcel-9",
  State: "ReadyToFulfill",
  ShippingMethodCode: "post",
  ShippingCostPaid: 50,
  AnipoRecipientRevision: 0,
  owner: { phone: "09120000000" },
  delivery_address: {
    FullName: "گیرنده بسته",
    Phone: "09120000001",
    FullAddress: "نشانی بسته",
    PostalCode: "1234567890",
    shipping_city: { Title: "تهران", shipping_province: { Title: "تهران" } },
  },
});
const member = (id: number, amount: number, count: number, weight = 100, Status = "Started") => ({
  id,
  Status,
  ShippingCost: id === 11 ? 50 : 0,
  contract: { Amount: amount },
  reserve_shipment: { id: 9 },
  order_items: [{ Count: count, product_variation: { product: { Weight: weight } } }],
});

function fixture(members = [member(11, 250, 2, 125), member(12, 300, 3, 100)], overrides = {}) {
  const record: any = { ...group(), ...overrides };
  const provider = {
    createOrUpdateOrder: jest.fn().mockResolvedValue({ ok: true, data: { issued: false } }),
    getOrder: jest
      .fn()
      .mockResolvedValue({ ok: true, data: { issued: true, barcode: "123456789012345678901234" } }),
    updateOrderStatus: jest.fn().mockResolvedValue({ ok: true }),
  };
  const fromDb = (name: string) =>
    name
      .replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
      .replace(/^anipo/, "Anipo")
      .replace(/^shipping/, "Shipping");
  const connection = () => {
    let conditions: Array<[string, string, any]> = [];
    let claim = false;
    let result: Array<{ id: number }> = [];
    const query: any = {
      where: (values: any) => {
        conditions.push(
          ...Object.entries(values).map(
            ([key, value]) => [key, "=", value] as [string, string, any],
          ),
        );
        return query;
      },
      andWhere: (key: any, op?: string, value?: any) => {
        if (typeof key === "function") {
          claim = true;
        } else
          conditions.push([key, value === undefined ? "=" : op!, value === undefined ? op : value]);
        return query;
      },
      update: (data: any) => {
        const allowed =
          conditions.every(([key, op, value]) => {
            const actual = record[fromDb(key)];
            return op === ">"
              ? new Date(actual).getTime() > new Date(value).getTime()
              : actual === value;
          }) &&
          (!claim ||
            !record.AnipoLeaseExpiresAt ||
            new Date(record.AnipoLeaseExpiresAt).getTime() <= Date.now());
        if (allowed) {
          for (const [key, value] of Object.entries(data))
            record[fromDb(key)] =
              key === "anipo_barcode_data" && typeof value === "string" ? JSON.parse(value) : value;
        }
        result = allowed ? [{ id: record.id }] : [];
        return query;
      },
      returning: () => Promise.resolve(result),
      then: (resolve: any, reject: any) => Promise.resolve(result.length).then(resolve, reject),
      catch: (reject: any) => Promise.resolve(result.length).catch(reject),
    };
    return query;
  };
  const strapi: any = {
    db: {
      connection,
      query: (uid: string) =>
        uid.includes("reserve-group")
          ? {
              findOne: jest.fn(async () => ({ ...record })),
              update: jest.fn(async ({ data }) => Object.assign(record, data)),
            }
          : { findMany: jest.fn(async () => members) },
    },
    service: () => provider,
    log: { error: jest.fn(), info: jest.fn() },
  };
  return { strapi, provider, record, members };
}

describe("shared reserve Anipo parcel", () => {
  beforeEach(() => jest.clearAllMocks());

  it("aggregates all paid members, with shipping charged once, and excludes cancelled/returned items", () => {
    const source = aggregateParcel({
      group: group(),
      members: [
        member(11, 250, 2),
        member(12, 300, 3),
        member(13, 1000, 20, 900, "Cancelled"),
        member(14, 1000, 20, 900, "Returned"),
      ],
    });
    expect(source.contract.Amount).toBe(550);
    expect(source.order_items).toHaveLength(2);
    expect(
      parcelSummary({ group: group(), members: [member(11, 250, 2), member(12, 300, 3)] }).weight,
    ).toBe(500);
  });

  it("registers one full parcel under a persistent reference", async () => {
    const f = fixture();
    const response = await submitReserveParcel(f.strapi, "parcel-9");
    expect(response.pending).toBe(true);
    expect(f.provider.createOrUpdateOrder).toHaveBeenCalledTimes(1);
    expect(f.provider.createOrUpdateOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        order_code: "11",
        weight_g: 550,
        order_total: 5500,
        package_count: 1,
        receiver_name: "گیرنده بسته",
        receiver_mobile: "09120000001",
      }),
    );
    expect(f.record.AnipoOrderCode).toBe("11");
    expect(f.record.AnipoLeaseToken).toBeNull();
    await submitReserveParcel(f.strapi, "parcel-9");
    expect(f.provider.createOrUpdateOrder).toHaveBeenCalledTimes(1);
  });

  it("prevents simultaneous requests from different members crossing the provider boundary twice", async () => {
    const f = fixture();
    let release!: (value: unknown) => void;
    f.provider.createOrUpdateOrder.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = submitReserveParcel(f.strapi, 9);
    while (!release) await Promise.resolve();
    await expect(submitReserveParcel(f.strapi, 9)).rejects.toMatchObject({
      code: "ANIPO_PARCEL_BUSY",
    });
    release({ ok: true, data: { issued: false } });
    await first;
    expect(f.provider.createOrUpdateOrder).toHaveBeenCalledTimes(1);
  });

  it("checks an uncertain POST outcome by its saved reference without posting again", async () => {
    const f = fixture();
    f.provider.createOrUpdateOrder.mockRejectedValueOnce(new Error("network timeout"));
    await expect(submitReserveParcel(f.strapi, 9)).rejects.toMatchObject({
      code: "ANIPO_REGISTER_ERROR",
    });
    expect(f.record.AnipoOrderCode).toBe("11");
    await submitReserveParcel(f.strapi, 9);
    expect(f.provider.createOrUpdateOrder).toHaveBeenCalledTimes(1);
    expect(f.provider.getOrder).toHaveBeenCalledWith("11");
    expect(f.record.AnipoBarcodeState).toBe("Issued");
  });

  it("retains cancellation intent while another provider operation owns the lease", async () => {
    const f = fixture();
    let release!: (value: unknown) => void;
    f.provider.createOrUpdateOrder.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = submitReserveParcel(f.strapi, 9);
    while (!release) await Promise.resolve();
    for (const member of f.members) member.Status = "Cancelled";
    await expect(reconcileReserveParcelCancellation(f.strapi, 9)).rejects.toMatchObject({
      code: "ANIPO_PARCEL_BUSY",
    });
    expect(f.record.AnipoCancellationPending).toBe(true);
    release({ ok: true, data: { issued: false } });
    await first;
    await reconcileReserveParcelCancellation(f.strapi, 9);
    expect(f.provider.updateOrderStatus).toHaveBeenCalledWith("11", expect.any(String));
    expect(f.record.AnipoCancellationPending).toBe(false);
  });

  it("only retries registration after a confirmed missing provider order, retaining its reference", async () => {
    const f = fixture();
    f.provider.createOrUpdateOrder.mockRejectedValueOnce(new Error("timeout"));
    await expect(submitReserveParcel(f.strapi, 9)).rejects.toMatchObject({
      code: "ANIPO_REGISTER_ERROR",
    });
    f.provider.getOrder.mockResolvedValueOnce({ ok: false, status: 404 } as any);
    await expect(submitReserveParcel(f.strapi, 9)).rejects.toMatchObject({
      code: "ANIPO_STATUS_ERROR",
    });
    expect(parcelSummary({ group: f.record, members: f.members })).toMatchObject({
      canSubmit: true,
      canCheck: false,
    });
    f.members[0].Status = "Cancelled";
    await submitReserveParcel(f.strapi, 9, { forceRetry: true });
    expect(f.provider.createOrUpdateOrder).toHaveBeenCalledTimes(2);
    expect(f.provider.createOrUpdateOrder).toHaveBeenLastCalledWith(
      expect.objectContaining({ order_code: "11" }),
    );
  });

  it("blocks label printing and further registration when provider barcodes conflict", async () => {
    const f = fixture();
    await submitReserveParcel(f.strapi, 9);
    f.provider.getOrder.mockResolvedValueOnce({
      ok: true,
      data: { issued: true, barcodes: ["111", "222"] },
    } as any);
    await refreshReserveParcel(f.strapi, 9);
    expect(parcelSummary({ group: f.record, members: f.members })).toMatchObject({
      state: "NeedsAttention",
      canPrintLabel: false,
      canSubmit: false,
      canCheck: false,
    });
    await expect(submitReserveParcel(f.strapi, 9)).rejects.toMatchObject({ status: 409 });
    expect(f.provider.createOrUpdateOrder).toHaveBeenCalledTimes(1);
  });

  it("keeps the provider identity and shipment alive when its original member is cancelled", async () => {
    const f = fixture();
    await submitReserveParcel(f.strapi, 9);
    f.members[0].Status = "Cancelled";
    await reconcileReserveParcelCancellation(f.strapi, 9);
    expect(f.provider.updateOrderStatus).not.toHaveBeenCalled();
    await refreshReserveParcel(f.strapi, 9);
    expect(f.provider.getOrder).toHaveBeenCalledWith("11");
    expect(claimGroupShippingBarcode).toHaveBeenCalledWith(f.strapi, {
      groupId: 9,
      barcode: "123456789012345678901234",
    });
  });

  it("cancels the one provider registration only when no eligible member remains", async () => {
    const f = fixture();
    await submitReserveParcel(f.strapi, 9);
    f.members.forEach((row) => {
      row.Status = "Cancelled";
    });
    await reconcileReserveParcelCancellation(f.strapi, 9);
    expect(f.provider.updateOrderStatus).toHaveBeenCalledTimes(1);
    expect(f.provider.updateOrderStatus).toHaveBeenCalledWith("11", expect.any(String));
    expect(f.record.AnipoBarcodeState).toBe("Voided");
  });

  it("adopts an unambiguous legacy registration, and blocks conflicting registrations", async () => {
    const legacy = {
      ...member(12, 300, 3),
      AnipoSubmittedAt: new Date(),
      AnipoBarcodeState: "Pending",
    };
    const adopted = fixture([member(11, 250, 2), legacy]);
    await submitReserveParcel(adopted.strapi, 9);
    expect(adopted.record.AnipoOrderCode).toBe("12");
    expect(adopted.provider.createOrUpdateOrder).not.toHaveBeenCalled();
    const conflict = fixture([{ ...member(11, 250, 2), AnipoSubmittedAt: new Date() }, legacy]);
    await expect(submitReserveParcel(conflict.strapi, 9)).rejects.toMatchObject({
      code: "ANIPO_GROUP_CONFLICT",
    });
    expect(conflict.provider.createOrUpdateOrder).not.toHaveBeenCalled();
    expect(
      effectiveParcelState(group(), [
        { ...member(11, 250, 2), ShippingBarcode: "111" },
        { ...member(12, 300, 3), ShippingBarcode: "222" },
      ]).AnipoLastError,
    ).toBe("ANIPO_GROUP_CONFLICT");
  });

  it("blocks held/non-postal groups and reuses issued labels", async () => {
    for (const override of [{ State: "Active" }, { ShippingMethodCode: "courier" }]) {
      const f = fixture(undefined, override);
      await expect(submitReserveParcel(f.strapi, 9)).rejects.toMatchObject({ status: 409 });
      expect(f.provider.createOrUpdateOrder).not.toHaveBeenCalled();
    }
    const issued = fixture(undefined, { ShippingBarcode: "123456789012345678901234" });
    const result = await submitReserveParcel(issued.strapi, 9);
    expect(result.issued).toBe(true);
    expect(issued.provider.createOrUpdateOrder).not.toHaveBeenCalled();
  });

  it("updates one shared recipient registration using full parcel weight and value", async () => {
    const f = fixture();
    await submitReserveParcel(f.strapi, 9);
    f.record.AnipoRecipientRevision = 1;
    f.record.delivery_address.FullName = "گیرنده جدید";
    await syncReserveParcelRecipient(f.strapi, 9);
    expect(f.provider.createOrUpdateOrder).toHaveBeenLastCalledWith(
      expect.objectContaining({
        order_code: "11",
        receiver_name: "گیرنده جدید",
        weight_g: 550,
        order_total: 5500,
      }),
    );
    expect(f.record.AnipoRecipientSyncedRevision).toBe(1);
  });
});
