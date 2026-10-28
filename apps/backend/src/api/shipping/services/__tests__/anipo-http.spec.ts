const mockPost = jest.fn();
const mockCreate = jest.fn(() => ({ post: mockPost }));
jest.mock("axios", () => ({ __esModule: true, default: { create: (...args: unknown[]) => mockCreate(...args) } }));

import createAnipoService from "../anipo";

describe("Anipo HTTP contract", () => {
  const priorToken = process.env.ANIPO_TOKEN;
  const log = { info: jest.fn(), error: jest.fn() };
  const service = createAnipoService({ strapi: { log } } as any);

  beforeEach(() => {
    process.env.ANIPO_TOKEN = "secret-test-token";
    mockPost.mockReset();
    mockCreate.mockClear();
    log.info.mockClear();
    log.error.mockClear();
  });
  afterAll(() => {
    if (priorToken === undefined) delete process.env.ANIPO_TOKEN;
    else process.env.ANIPO_TOKEN = priorToken;
  });

  it.each([200, 201])("accepts registration HTTP %s and sends grams with JSON headers", async (status) => {
    mockPost.mockResolvedValue({ status, data: { ok: true, barcode: null } });
    const result = await service.createOrUpdateOrder({ order_code: "44", receiver_name: "Test", receiver_province: "تهران", receiver_city: "تهران", weight_g: 500, box_type: 3, order_total: 9500 });
    expect(result).toMatchObject({ ok: true, status });
    expect(mockPost).toHaveBeenCalledWith("/orders", expect.objectContaining({ order_code: "44", weight_g: 500, box_type: 3, order_total: 9500 }));
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ timeout: 15000, headers: expect.objectContaining({ Accept: "application/json" }) }));
    expect(JSON.stringify([...log.info.mock.calls, ...log.error.mock.calls])).not.toContain("secret-test-token");
  });

  it("returns a 422 with safe field errors without logging credentials or raw payload", async () => {
    mockPost.mockRejectedValue({ response: { status: 422, data: { message: "validation_failed", errors: { receiver_postal_code: ["کد پستی نامعتبر است"] } } } });
    const result = await service.createOrUpdateOrder({ order_code: "44", receiver_name: "Test", receiver_province: "تهران", receiver_city: "تهران" });
    expect(result).toMatchObject({ ok: false, status: 422, validationErrors: { receiver_postal_code: ["کد پستی نامعتبر است"] } });
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("secret-test-token");
  });

  it("rejects batches larger than 200 without an HTTP request", async () => {
    expect(await service.getOrderBarcodes(Array.from({ length: 201 }, (_, i) => String(i)))).toMatchObject({ ok: false, status: 422 });
    expect(mockPost).not.toHaveBeenCalled();
  });
});
