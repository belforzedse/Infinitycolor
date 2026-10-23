import { fireEvent, render, screen } from "@testing-library/react";
import SizeGuideEditor from "../SizeGuideEditor";

const columns = [
  { key: "height", title: "قد" },
  { key: "chest", title: "دور سینه" },
];

describe("legacy size guide editor", () => {
  let alert: jest.SpyInstance;
  beforeEach(() => {
    alert = jest.spyOn(window, "alert").mockImplementation();
  });
  afterEach(() => alert.mockRestore());

  it("saves rows with blank or missing measurements", () => {
    const onSave = jest.fn();
    const rows = [{ size: "M", height: "50", chest: "" }, { size: "L" }];
    render(
      <SizeGuideEditor
        initialData={rows}
        columns={columns}
        onColumnTitleEdit={jest.fn()}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "ذخیره راهنما" }));

    expect(onSave).toHaveBeenCalledWith(rows);
    expect(alert).not.toHaveBeenCalled();
  });

  it.each([
    { rows: [{ size: "   ", height: "50", chest: "60" }], columns },
    { rows: [{ size: "M" }], columns: [] },
    { rows: [{ size: "M", height: "50" }], columns: [{ key: "height", title: "   " }] },
  ])(
    "still requires sizes and named measurement columns: %j",
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
});
