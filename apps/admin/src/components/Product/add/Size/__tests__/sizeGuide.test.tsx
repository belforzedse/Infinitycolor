import { fireEvent, render, screen } from "@testing-library/react";

jest.mock("@/services", () => ({ apiClient: {} }));

import { sizeGuideDraftPayload, type SizeGuideDraft } from "..";
import SizeGuideEditor from "../SizeGuideEditor";
import SizeTable from "../Table";

const columns = [
  { key: "height", title: "قد" },
  { key: "chest", title: "دور سینه" },
];
const partialRows = [{ size: "M", height: "50", chest: "" }, { size: "L" }];
const draft = (overrides: Partial<SizeGuideDraft> = {}): SizeGuideDraft => ({
  data: partialRows,
  columns,
  helperId: 15,
  saved: "[]",
  editing: true,
  ...overrides,
});

describe("size guide product payload", () => {
  it("allows blank headers in a combined product save", () => {
    expect(sizeGuideDraftPayload(draft({ columns: [{ key: "height", title: "   " }] }))?.Helper)
      .toEqual([["سایز", "---"], ["M", "50"], ["L", ""]]);
  });

  it("allows missing measurements and serializes them as empty cells", () => {
    expect(sizeGuideDraftPayload(draft())).toEqual({
      id: 15,
      Helper: [
        ["سایز", "قد", "دور سینه"],
        ["M", "50", ""],
        ["L", "", ""],
      ],
    });
  });

  it("omits an unchanged partial guide", () => {
    const saved = JSON.stringify(sizeGuideDraftPayload(draft())?.Helper);
    expect(sizeGuideDraftPayload(draft({ saved }))).toBeUndefined();
  });

  it.each<Partial<SizeGuideDraft>>([
    { data: [], saved: "previous guide" },
    { data: [{ size: "   ", height: "50" }] },
    { columns: [] },
  ])(
    "still rejects a guide without sizes or measurement columns: %j",
    (invalid) => {
      expect(() => sizeGuideDraftPayload(draft(invalid))).toThrow(
        "لطفاً جدول راهنمای سایز را تکمیل کنید",
      );
    },
  );
});

describe("size guide editor", () => {
  let alert: jest.SpyInstance;
  beforeEach(() => {
    alert = jest.spyOn(window, "alert").mockImplementation();
  });
  afterEach(() => alert.mockRestore());

  it("saves a guide with blank measurements", () => {
    const onSave = jest.fn();
    render(
      <SizeGuideEditor
        initialData={partialRows}
        columns={columns}
        onColumnTitleEdit={jest.fn()}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "ذخیره راهنما" }));

    expect(onSave).toHaveBeenCalledWith(partialRows);
    expect(alert).not.toHaveBeenCalled();
  });

  it.each([
    { rows: [{ size: "   ", height: "50", chest: "60" }], columns },
    { rows: partialRows, columns: [] },
  ])(
    "keeps required guide structure validation: %j",
    ({ rows, columns: guideColumns }) => {
      const onSave = jest.fn();
      render(
        <SizeGuideEditor
          initialData={rows}
          columns={guideColumns}
          onColumnTitleEdit={jest.fn()}
          onSave={onSave}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "ذخیره راهنما" }));

      expect(onSave).not.toHaveBeenCalled();
      expect(alert).toHaveBeenCalledTimes(1);
    },
  );

  it("shows missing measurements as dashes in the saved guide", () => {
    render(<SizeTable data={partialRows} columns={columns} />);
    expect(screen.getAllByRole("cell").map((cell) => cell.textContent)).toEqual(
      ["M", "50", "-", "L", "-", "-"],
    );
  });

  it("turns a cleared header into dashes without removing its measurements", () => {
    const onSave = jest.fn();
    const onColumnTitleEdit = jest.fn();
    const onDataChange = jest.fn();
    const rows = [{ size: "M", height: "50", chest: "60" }];
    render(<SizeGuideEditor initialData={rows} columns={columns}
      onColumnTitleEdit={onColumnTitleEdit} onDataChange={onDataChange} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "قد", exact: true }));
    const header = screen.getByPlaceholderText("نام ستون");
    fireEvent.change(header, { target: { value: "   " } });
    fireEvent.blur(header);
    expect(onColumnTitleEdit).toHaveBeenCalledWith("height", "---");
    expect(onDataChange).toHaveBeenLastCalledWith(rows, [
      { key: "height", title: "---" }, { key: "chest", title: "دور سینه" },
    ]);
    expect(screen.getByText("---")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "ذخیره راهنما" }));
    expect(onSave).toHaveBeenCalledWith(rows);
    expect(alert).not.toHaveBeenCalled();
  });

  it("saves a newly added unnamed header", () => {
    const onSave = jest.fn();
    render(<SizeGuideEditor initialData={[{ size: "M", height: "50" }]}
      columns={[{ key: "height", title: "" }]} onColumnTitleEdit={jest.fn()} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "ذخیره راهنما" }));
    expect(onSave).toHaveBeenCalledWith([{ size: "M", height: "50" }]);
    expect(alert).not.toHaveBeenCalled();
  });
});
