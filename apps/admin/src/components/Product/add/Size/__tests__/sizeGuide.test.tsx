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
    { columns: [{ key: "height", title: "   " }] },
  ])(
    "still rejects a guide without sizes or named measurement columns: %j",
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
    {
      rows: [{ size: "M", height: "50" }],
      columns: [{ key: "height", title: "   " }],
    },
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
});
