import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import FilterBar from "../FilterBar";
import type { ReportFilters } from "../useReportFilters";
import { getAllCategories } from "@/services/super-admin/product/category/getAll";

jest.mock("use-debounce", () => ({
  useDebouncedCallback: (callback: (value: string) => void) => callback,
}));

jest.mock("@/services/super-admin/product/category/getAll", () => ({
  getAllCategories: jest.fn(),
}));

function makeFilters(): ReportFilters {
  return {
    start: "2026-01-01",
    end: "2026-01-31",
    tab: "overview",
    q: "",
    cat: "",
    ptype: "",
    stock: "",
    filters: { start: "2026-01-01", end: "2026-01-31" } as ReportFilters["filters"],
    setStart: jest.fn(),
    setEnd: jest.fn(),
    setRange: jest.fn(),
    setTab: jest.fn(),
    setQ: jest.fn(),
    setCat: jest.fn(),
    setPtype: jest.fn(),
    setStock: jest.fn(),
  };
}

describe("Product report FilterBar", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getAllCategories as jest.Mock).mockResolvedValue({ data: [] });
  });

  it("renders nothing when product filters are hidden — the layout owns the period", () => {
    const { container } = render(
      <FilterBar f={makeFilters()} showProductFilters={false} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("از تاریخ")).not.toBeInTheDocument();
    expect(screen.queryByText("تا تاریخ")).not.toBeInTheDocument();
    expect(getAllCategories).not.toHaveBeenCalled();
  });

  it("requests categories and shows product filters on the performance tab", async () => {
    render(<FilterBar f={makeFilters()} showProductFilters />);

    await waitFor(() => {
      expect(getAllCategories).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText("جستجوی نام / SKU")).toBeInTheDocument();
    expect(screen.getByText("دسته‌بندی")).toBeInTheDocument();
    expect(screen.queryByText("از تاریخ")).not.toBeInTheDocument();
    expect(screen.queryByText("تا تاریخ")).not.toBeInTheDocument();
  });

  it("forwards search input to setQ", async () => {
    const filters = makeFilters();
    render(<FilterBar f={filters} showProductFilters />);
    await waitFor(() => {
      expect(getAllCategories).toHaveBeenCalled();
    });

    fireEvent.change(screen.getByPlaceholderText("نام محصول یا کد..."), {
      target: { value: "SKU-1" },
    });
    expect(filters.setQ).toHaveBeenCalledWith("SKU-1");
  });
});
