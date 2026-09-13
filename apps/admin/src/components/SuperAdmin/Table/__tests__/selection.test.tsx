import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ColumnDef } from "@tanstack/react-table";

const mockSetQueryState = jest.fn();
const mockSetRefresh = jest.fn();

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
  useAtom: () => [false, mockSetRefresh],
}));
jest.mock("@/components/Skeletons/ReportTableSkeleton", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("../AnimatedTableRow", () => ({
  AnimatedTableRow: ({ children }: { children: React.ReactNode }) => (
    <tr>{children}</tr>
  ),
}));

import { SuperAdminTable } from "../index";

type Row = { id: string; name: string };

const columns: ColumnDef<Row, unknown>[] = [
  { accessorKey: "name", header: "نام" },
];

const page = (rows: Row[]) => ({
  data: rows,
  meta: { pagination: { page: 1, pageSize: 25, pageCount: 1, total: rows.length } },
});

const ALL: Row[] = [
  { id: "1", name: "یک" },
  { id: "2", name: "دو" },
  { id: "3", name: "سه" },
];

/** The mobile card checkboxes are the only labelled per-row ones. */
const rowBoxes = () =>
  screen.getAllByLabelText("انتخاب ردیف") as HTMLInputElement[];

async function settle() {
  await act(async () => {
    jest.advanceTimersByTime(300);
    await Promise.resolve();
  });
}

function renderTable(
  dataLoader: jest.Mock,
  onBulkAction: (id: string, rows: Row[]) => Promise<void> | void,
) {
  return render(
    <SuperAdminTable
      columns={columns}
      dataLoader={dataLoader}
      dataLoaderKey="selection-fixture"
      refreshOnVisibility={false}
      enableSelection
      bulkOptions={[{ id: "touch", title: "اقدام" }]}
      onBulkAction={onBulkAction as never}
    />,
  );
}

/** The action picker is a custom listbox: open it, then click the option. */
async function runBulkAction() {
  const trigger = screen.getAllByRole("button", { expanded: false })[0];
  await act(async () => {
    fireEvent.click(trigger);
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.click(screen.getByText("اقدام"));
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.click(screen.getAllByTestId("bulk-action-execute")[0]);
    await Promise.resolve();
  });
}

describe("SuperAdminTable selection", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockSetQueryState.mockReset();
    mockSetRefresh.mockReset();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it("keeps the selected rows checked after a bulk action completes", async () => {
    const dataLoader = jest.fn().mockResolvedValue(page(ALL));
    const onBulkAction = jest.fn().mockResolvedValue(undefined);

    renderTable(dataLoader, onBulkAction);
    await settle();
    await waitFor(() => expect(rowBoxes()).toHaveLength(3));

    fireEvent.click(rowBoxes()[0]);
    fireEvent.click(rowBoxes()[2]);
    expect(screen.getAllByTestId("bulk-selected-count")[0]).toHaveTextContent("2");

    await runBulkAction();

    expect(onBulkAction).toHaveBeenCalledWith(
      "touch",
      [ALL[0], ALL[2]],
      undefined,
    );
    // The whole point: the operator can run a second action without re-picking.
    expect(rowBoxes()[0].checked).toBe(true);
    expect(rowBoxes()[1].checked).toBe(false);
    expect(rowBoxes()[2].checked).toBe(true);
    expect(screen.getAllByTestId("bulk-selected-count")[0]).toHaveTextContent("2");
  });

  it("drops rows that leave the result set and keeps the survivors checked", async () => {
    // The second read is what a real refetch returns once row 3 no longer
    // matches the active tab.
    const dataLoader = jest
      .fn()
      .mockResolvedValueOnce(page(ALL))
      .mockResolvedValue(page([ALL[0], ALL[1]]));
    const onBulkAction = jest.fn().mockResolvedValue(undefined);

    const view = renderTable(dataLoader, onBulkAction);
    await settle();
    await waitFor(() => expect(rowBoxes()).toHaveLength(3));

    fireEvent.click(rowBoxes()[0]);
    fireEvent.click(rowBoxes()[2]);
    expect(screen.getAllByTestId("bulk-selected-count")[0]).toHaveTextContent("2");

    await runBulkAction();

    // Force the refetch the page handler would trigger via `refreshTable`.
    view.rerender(
      <SuperAdminTable
        columns={columns}
        dataLoader={dataLoader}
        dataLoaderKey="selection-fixture-refetched"
        refreshOnVisibility={false}
        enableSelection
        bulkOptions={[{ id: "touch", title: "اقدام" }]}
        onBulkAction={onBulkAction as never}
      />,
    );
    await settle();

    await waitFor(() => expect(rowBoxes()).toHaveLength(2));
    expect(rowBoxes()[0].checked).toBe(true);
    expect(rowBoxes()[1].checked).toBe(false);
    // The vanished row is no longer counted, so the badge cannot describe rows
    // that are not on screen and that no action would touch.
    expect(screen.getAllByTestId("bulk-selected-count")[0]).toHaveTextContent("1");
  });

  it("keeps the selection when the bulk action succeeded for nothing", async () => {
    // Both order and product handlers report failures through toasts and return
    // normally, so a fully failed batch looks exactly like this.
    const dataLoader = jest.fn().mockResolvedValue(page(ALL));
    const onBulkAction = jest.fn().mockResolvedValue(undefined);

    renderTable(dataLoader, onBulkAction);
    await settle();
    await waitFor(() => expect(rowBoxes()).toHaveLength(3));

    fireEvent.click(rowBoxes()[1]);
    await runBulkAction();

    expect(rowBoxes()[1].checked).toBe(true);
    expect(screen.getAllByTestId("bulk-selected-count")[0]).toHaveTextContent("1");
  });

  it("selects and clears every row on the current page from the header checkbox", async () => {
    const dataLoader = jest.fn().mockResolvedValue(page(ALL));
    const onBulkAction = jest.fn().mockResolvedValue(undefined);

    renderTable(dataLoader, onBulkAction);
    await settle();
    await waitFor(() => expect(rowBoxes()).toHaveLength(3));

    const toggleAll = screen.getAllByLabelText("انتخاب همه")[0];
    fireEvent.click(toggleAll);
    expect(rowBoxes().every((box) => box.checked)).toBe(true);

    fireEvent.click(toggleAll);
    expect(rowBoxes().some((box) => box.checked)).toBe(false);
    expect(screen.queryByTestId("bulk-selected-count")).toBeNull();
  });
});
