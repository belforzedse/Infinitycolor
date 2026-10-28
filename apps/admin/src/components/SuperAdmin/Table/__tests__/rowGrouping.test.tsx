import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ColumnDef } from "@tanstack/react-table";
import { groupTableRows, type TableRowGrouping } from "../rowGrouping";

const mockSetQueryState = jest.fn();
jest.mock("nuqs", () => ({
  useQueryState: (key: string) => {
    if (key === "filter") return [[], mockSetQueryState];
    if (key === "totalSize") return [0, mockSetQueryState];
    if (key === "pageSize") return ["25", mockSetQueryState];
    return ["1", mockSetQueryState];
  },
}));
jest.mock("jotai", () => ({
  atom: () => ({}),
  useAtom: () => [false, jest.fn()],
}));
jest.mock("../AnimatedTableRow", () => ({
  AnimatedTableRow: ({ children }: { children: React.ReactNode }) => (
    <tr>{children}</tr>
  ),
}));

import { SuperAdminTable } from "../index";

type Item = { id: string; name: string; parcel?: string };
const items: Item[] = [
  { id: "1", name: "First parcel order", parcel: "parcel-a" },
  { id: "2", name: "Regular order" },
  { id: "3", name: "Second parcel order", parcel: "parcel-a" },
  { id: "4", name: "Other parcel order", parcel: "parcel-b" },
];
const columns: ColumnDef<Item>[] = [{ accessorKey: "name", header: "Order" }];
const grouping: TableRowGrouping<Item> = {
  getKey: (row) => row.parcel,
  renderHeader: ({ groupKey, expanded, onToggle, selection }) => (
    <div data-testid={`header-${groupKey}`}>
      {selection && (
        <input
          type="checkbox"
          aria-label={`Select ${groupKey}`}
          checked={selection.checked}
          ref={(element) => {
            if (element) element.indeterminate = selection.indeterminate;
          }}
          onChange={(event) => selection.onChange(event.target.checked)}
        />
      )}
      <button aria-expanded={expanded} onClick={onToggle}>
        {groupKey}
      </button>
    </div>
  ),
};

function table(data = items) {
  return (
    <SuperAdminTable
      columns={columns}
      data={data}
      rowGrouping={grouping}
      enableSelection
      bulkOptions={[{ id: "print", title: "Print" }]}
      mobileTable={(rows, selection) => (
        <div data-testid="mobile-rows">
          {rows?.map((row) => (
            <label key={row.id}>
              <input
                type="checkbox"
                aria-label={`Select order ${row.id}`}
                checked={selection?.selectedIds.has(row.id) ?? false}
                onChange={(event) =>
                  selection?.onSelectionChange(row.id, event.target.checked)
                }
              />
              {row.name}
            </label>
          ))}
        </div>
      )}
    />
  );
}

describe("grouped table rows", () => {
  it("collects interleaved members at the first member while keeping regular orders and other parcels", () => {
    expect(groupTableRows(items, (row) => row.parcel)).toEqual([
      { groupKey: "parcel-a", rows: [items[0], items[2]] },
      { groupKey: null, rows: [items[1]] },
      { groupKey: "parcel-b", rows: [items[3]] },
    ]);
    expect(items.map((item) => item.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("groups only matching rows on the current page, including single-member parcels", () => {
    expect(groupTableRows([items[2]], (row) => row.parcel)).toEqual([
      { groupKey: "parcel-a", rows: [items[2]] },
    ]);
    expect(groupTableRows(items)).toEqual([{ groupKey: null, rows: items }]);
  });

  it("collapses parcel members in both layouts and toggles them together", async () => {
    const view = render(table());
    await waitFor(() =>
      expect(screen.getAllByTestId("header-parcel-a")).toHaveLength(2),
    );
    expect(screen.queryByText("First parcel order")).not.toBeInTheDocument();
    expect(screen.getAllByText("Regular order")).toHaveLength(2);

    fireEvent.click(screen.getAllByRole("button", { name: "parcel-a" })[0]);
    expect(screen.getAllByText("First parcel order")).toHaveLength(2);
    expect(screen.getAllByText("Second parcel order")).toHaveLength(2);
    expect(screen.queryByText("Other parcel order")).not.toBeInTheDocument();
    expect(
      within(view.container.querySelector("tbody")!).getAllByRole("row"),
    ).toHaveLength(5);

    fireEvent.click(screen.getAllByRole("button", { name: "parcel-a" })[1]);
    expect(screen.queryByText("First parcel order")).not.toBeInTheDocument();
  });

  it("selects just the parcel's loaded members while collapsed and retains selection through expansion", async () => {
    render(table());
    await waitFor(() =>
      expect(screen.getAllByLabelText("Select parcel-a")).toHaveLength(2),
    );
    fireEvent.click(screen.getAllByLabelText("Select parcel-a")[0]);
    expect(screen.getAllByTestId("bulk-selected-count")[0]).toHaveTextContent(
      "2",
    );
    fireEvent.click(screen.getAllByRole("button", { name: "parcel-a" })[1]);
    expect(screen.getByLabelText("Select order 1")).toBeChecked();
    expect(screen.getByLabelText("Select order 3")).toBeChecked();
    expect(screen.getByLabelText("Select order 2")).not.toBeChecked();
    expect(screen.getAllByLabelText("Select parcel-b")[0]).not.toBeChecked();

    fireEvent.click(screen.getByLabelText("Select order 1"));
    expect(
      (screen.getAllByLabelText("Select parcel-a")[0] as HTMLInputElement)
        .indeterminate,
    ).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "parcel-a" })[0]);
    expect(screen.getAllByTestId("bulk-selected-count")[0]).toHaveTextContent(
      "1",
    );
  });

  it("prunes selection when a filter removes a parcel member", async () => {
    const view = render(table());
    await waitFor(() =>
      expect(screen.getAllByLabelText("Select parcel-a")).toHaveLength(2),
    );
    fireEvent.click(screen.getAllByLabelText("Select parcel-a")[0]);
    view.rerender(table([items[2]]));
    await waitFor(() =>
      expect(screen.getAllByTestId("bulk-selected-count")[0]).toHaveTextContent(
        "1",
      ),
    );
    expect(screen.getAllByLabelText("Select parcel-a")[0]).toBeChecked();
  });
});
