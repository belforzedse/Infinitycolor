import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import SuperAdminTableSelect from "../Select";

/**
 * This is the "اقدام دسته جمعی" bulk-action control on the products table (and
 * the page-size picker). It was a hand-rolled dropdown around a bare useState
 * with no outside-click and no Escape handling, so it stayed open until the
 * trigger was clicked again — the reported bulk-menu dismissal defect.
 */
const OPTIONS = [
  { id: "", title: "اقدام دسته جمعی" },
  { id: "delete", title: "حذف" },
  { id: "publish", title: "انتشار" },
];

describe("SuperAdminTableSelect dismissal", () => {
  it("closes when the pointer goes down outside it", async () => {
    render(
      <div>
        <SuperAdminTableSelect options={OPTIONS} />
        <button type="button">جای دیگر</button>
      </div>,
    );

    await userEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByRole("button", { name: "حذف" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "جای دیگر" }));

    expect(
      screen.queryByRole("button", { name: "حذف" }),
    ).not.toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    render(<SuperAdminTableSelect options={OPTIONS} />);

    await userEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByRole("button", { name: "انتشار" })).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    expect(
      screen.queryByRole("button", { name: "انتشار" }),
    ).not.toBeInTheDocument();
  });

  it("still selects an option and reports it", async () => {
    const onOptionSelect = jest.fn();
    render(
      <SuperAdminTableSelect
        options={OPTIONS}
        onOptionSelect={onOptionSelect}
      />,
    );

    await userEvent.click(screen.getByRole("button", { expanded: false }));
    await userEvent.click(screen.getByRole("button", { name: "حذف" }));

    expect(onOptionSelect).toHaveBeenCalledWith("delete");
    expect(
      screen.queryByRole("button", { name: "انتشار" }),
    ).not.toBeInTheDocument();
  });
});
