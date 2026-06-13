import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import FilterBar from "../FilterBar";
import { getAllCategories } from "@/services/super-admin/product/category/getAll";

jest.mock("zaman", () => ({
  DatePicker: ({ onChange, inputClass, defaultValue }: any) => (
    <input
      className={inputClass}
      defaultValue={defaultValue instanceof Date ? defaultValue.toISOString().slice(0, 10) : ""}
      onChange={(event) => onChange(new Date(event.target.value))}
    />
  ),
}));

jest.mock("use-debounce", () => ({
  useDebouncedCallback: (callback: (...args: any[]) => void) => callback,
}));

jest.mock("@/services/super-admin/product/category/getAll", () => ({
  getAllCategories: jest.fn(),
}));

const mockSetRange = jest.fn();

jest.mock("../useReportFilters", () => ({
  useReportFilters: () => ({
    start: "2026-01-01",
    end: "2026-01-31",
    q: "",
    cat: "",
    ptype: "",
    stock: "",
    setStart: jest.fn(),
    setEnd: jest.fn(),
    setQ: jest.fn(),
    setCat: jest.fn(),
    setPtype: jest.fn(),
    setStock: jest.fn(),
    setRange: mockSetRange,
  }),
}));

describe("Product report FilterBar", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    (getAllCategories as jest.Mock).mockResolvedValue({ data: [] });
  });

  it("does not request categories when product filters are hidden", async () => {
    render(<FilterBar showProductFilters={false} />);

    await waitFor(() => {
      expect(getAllCategories).not.toHaveBeenCalled();
    });
  });

  it("requests categories when product filters are shown", async () => {
    render(<FilterBar showProductFilters />);

    await waitFor(() => {
      expect(getAllCategories).toHaveBeenCalledTimes(1);
    });
  });

  it("applies quick date ranges with a single range update", () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-06-13T12:00:00Z"));

    render(<FilterBar showProductFilters={false} />);

    fireEvent.click(screen.getAllByRole("button")[0]);

    expect(mockSetRange).toHaveBeenCalledWith({
      start: "2026-06-06",
      end: "2026-06-13",
    });
  });
});
