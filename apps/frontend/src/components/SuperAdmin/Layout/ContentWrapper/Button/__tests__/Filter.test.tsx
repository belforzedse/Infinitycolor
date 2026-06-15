import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import FilterButton from "../Filter";

let mockQueryState: Record<string, any>;
const mockSetters: Record<string, jest.Mock> = {};

jest.mock("nuqs", () => ({
  useQueryState: (key: string, options: { defaultValue: unknown }) => {
    if (!(key in mockSetters)) {
      mockSetters[key] = jest.fn(async (value) => {
        mockQueryState[key] = typeof value === "function" ? value(mockQueryState[key]) : value;
      });
    }

    return [mockQueryState[key] ?? options.defaultValue, mockSetters[key]];
  },
}));

jest.mock("@/components/SuperAdmin/Table/Select", () => ({
  __esModule: true,
  default: ({
    options,
    selectedOption,
    onOptionSelect,
  }: {
    options: { id: string | number; title: string }[];
    selectedOption?: string | number;
    onOptionSelect?: (id: string | number) => void;
  }) => (
    <select
      aria-label={options[0]?.title}
      value={selectedOption ?? ""}
      onChange={(event) => onOptionSelect?.(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.title}
        </option>
      ))}
    </select>
  ),
}));

describe("SuperAdmin advanced filter drawer", () => {
  beforeEach(() => {
    mockQueryState = {
      filter: [],
      page: "3",
    };
    Object.keys(mockSetters).forEach((key) => mockSetters[key].mockClear());
  });

  it("keeps edits as draft until apply, then resets pagination", async () => {
    render(
      <FilterButton
        isFilterOpen
        setFilterIsOpen={jest.fn()}
        options={[
          { id: "[Description]", title: "توضیحات", type: "text" },
          { id: "[contract][Amount]", title: "مبلغ", type: "number" },
        ]}
      />,
    );

    fireEvent.click(screen.getByText("افزودن فیلتر"));
    fireEvent.change(screen.getByLabelText("فیلد"), { target: { value: "[Description]" } });
    fireEvent.change(screen.getByLabelText("عملگر"), { target: { value: "$containsi" } });
    fireEvent.change(screen.getByPlaceholderText("مقدار"), { target: { value: "E2E_DO_NOT_USE" } });

    expect(mockSetters.filter).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("advanced-filter-apply"));

    await waitFor(() => {
      expect(mockSetters.filter).toHaveBeenCalledWith([
        { field: "[Description]", operator: "$containsi", value: "E2E_DO_NOT_USE" },
      ]);
      expect(mockSetters.page).toHaveBeenCalledWith("1");
    });
  });

  it("clears filters and renders active chips with Persian labels", async () => {
    mockQueryState.filter = [{ field: "[Description]", operator: "$containsi", value: "تست" }];

    render(
      <FilterButton
        isFilterOpen
        setFilterIsOpen={jest.fn()}
        options={[{ id: "[Description]", title: "توضیحات", type: "text" }]}
      />,
    );

    expect(screen.getByText("توضیحات: شامل تست")).toBeInTheDocument();

    fireEvent.click(screen.getByText("پاک کردن فیلترها"));

    await waitFor(() => {
      expect(mockSetters.filter).toHaveBeenCalledWith([]);
      expect(mockSetters.page).toHaveBeenCalledWith("1");
    });
  });
});
