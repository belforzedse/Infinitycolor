import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockGet = jest.fn();
const mockPut = jest.fn();
const mockPost = jest.fn();
jest.mock("@/services", () => ({
  apiClient: {
    get: (...args: unknown[]) => mockGet(...args),
    put: (...args: unknown[]) => mockPut(...args),
    post: (...args: unknown[]) => mockPost(...args),
    delete: jest.fn(),
  },
}));
jest.mock("@/services/product/variation-options", () => ({ searchColors: jest.fn() }));
jest.mock("@/hooks/useCan", () => ({ useCan: () => true }));
jest.mock("@/lib/api-cache", () => ({ apiCache: { clearByPattern: jest.fn() } }));
const mockToastSuccess = jest.fn();
jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { success: (...args: unknown[]) => mockToastSuccess(...args), error: jest.fn() },
}));

import { ProductEditorContext } from "@/hooks/product/ProductEditorContext";
import { ProductEditorSession, type ProductEditSnapshot } from "@/services/super-admin/product/editor-session";
import ProductVariables from "../index";

const variation = (id: number, stockRevision = 0) => ({
  id,
  attributes: {
    SKU: `SKU-${id}`,
    Price: "100",
    IsPublished: true,
    product: { data: { id: 5 } },
    product_variation_size: { data: { id: id + 100, attributes: { Title: `size-${id}` } } },
    product_stock: { data: { id: id + 200, attributes: { Count: 4, StockRevision: stockRevision } } },
    selected_attribute_terms: { data: [] },
  },
});
const snapshot = (rows: ReturnType<typeof variation>[], revision = 7) => ({
  product: { id: 5, attributes: { product_variations: { data: rows } } },
  revision,
}) as unknown as ProductEditSnapshot;

async function applyToAll(price: string, stock?: string) {
  await userEvent.click(screen.getByRole("button", { name: "انتخاب همه" }));
  await userEvent.click(screen.getByRole("button", { name: "ویرایش گروهی" }));
  if (price) await userEvent.type(screen.getAllByPlaceholderText("بدون تغییر")[0], price);
  if (stock) await userEvent.type(screen.getAllByPlaceholderText("بدون تغییر")[2], stock);
  await userEvent.click(screen.getByRole("button", { name: "ثبت تغییرات" }));
}

describe("saving every variation of one product", () => {
  let session: ProductEditorSession | undefined;
  beforeEach(() => {
    jest.clearAllMocks();
    mockPut.mockResolvedValue({ data: {} });
  });
  afterEach(() => { session?.dispose(); session = undefined; });

  it("loads later pages after a refresh and includes them in select all", async () => {
    mockGet.mockImplementation(async (url: string) => ({
      data: url.includes("pagination[page]=2") ? [variation(12)] : [variation(11)],
      meta: { pagination: { page: url.includes("pagination[page]=2") ? 2 : 1, pageSize: 1, pageCount: 2, total: 2 } },
    }));
    render(<ProductVariables productId={5} refreshKey={1} />);
    await screen.findAllByText("size-12");
    await applyToAll("120");

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith("تغییرات روی 2 تنوع اعمال شد"));
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockPut.mock.calls.map(([url]) => url)).toEqual([
      "/products/5/editor/variations/11", "/products/5/editor/variations/12",
    ]);
    for (const [, body, options] of mockPut.mock.calls) {
      expect(body).toEqual({ data: { Price: 120 } });
      expect(options).toEqual({ retries: 0 });
    }
  });

  it("advances the real editor proof and each row's stock revision across bulk saves", async () => {
    const initial = [variation(11, 3), variation(12, 8)];
    const now = new Date();
    mockPost.mockResolvedValue({ data: {
      lease: { token: "fixture-proof", generation: 2, editorInstanceId: "fixture-instance", serverNow: now.toISOString(), expiresAt: new Date(now.getTime() + 90_000).toISOString() },
      snapshot: snapshot(initial),
    } });
    session = new ProductEditorSession(5, jest.fn());
    await act(() => session!.acquire());
    let revision = 7;
    mockPut.mockImplementation(async (_url: string, body: { stock: { id: number; Count: number; expectedStockRevision: number } }) => {
      const updated = initial.map((row) => row.attributes.product_stock.data.id === body.stock.id ? {
        ...row,
        attributes: { ...row.attributes, product_stock: { data: { id: body.stock.id, attributes: { Count: body.stock.Count, StockRevision: body.stock.expectedStockRevision + 1 } } } },
      } : row);
      revision += 1;
      return { data: snapshot(updated, revision), meta: { editRevision: revision } };
    });
    render(<ProductEditorContext.Provider value={session}><ProductVariables productId={5} /></ProductEditorContext.Provider>);
    await screen.findAllByText("size-12");
    await applyToAll("120", "9");
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledTimes(1));
    await applyToAll("", "10");
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledTimes(2));

    expect(mockPut.mock.calls.map(([, body]) => body.stock)).toEqual([
      { id: 211, Count: 9, expectedStockRevision: 3 },
      { id: 212, Count: 9, expectedStockRevision: 8 },
      { id: 211, Count: 10, expectedStockRevision: 4 },
      { id: 212, Count: 10, expectedStockRevision: 9 },
    ]);
    expect(mockPut.mock.calls.map(([, , options]) => options.headers["X-Product-Expected-Revision"])).toEqual(["7", "8", "9", "10"]);
    for (const [, , options] of mockPut.mock.calls) {
      expect(options).toMatchObject({ retries: 0, headers: { "X-Product-Edit-Token": "fixture-proof", "X-Product-Edit-Generation": "2" } });
    }
    expect(session.state.phase).toBe("editing");
  });
});
