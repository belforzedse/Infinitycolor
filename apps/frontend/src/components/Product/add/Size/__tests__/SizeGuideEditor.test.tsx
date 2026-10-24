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
  ])(
    "still requires sizes and measurement columns: %j",
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
