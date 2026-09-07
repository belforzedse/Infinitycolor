import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MobileTable, type Category } from "../table";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

/**
 * Staff were shown a parent/child metaphor lifted straight from the schema:
 * "مشاهده فرزندان", "بدون فرزند", "فرزند دسته‌بندی". The action opens
 * subcategories, so it should say so — and a subcategory card should name the
 * category it actually sits under rather than restating that it is nested.
 */
const CATEGORY: Category = {
  id: "12",
  attributes: {
    Title: "کیف و کفش",
    Slug: "bags-and-shoes",
    children: {
      data: [
        { id: 34, attributes: { Title: "کفش زنانه", Slug: "womens-shoes" } },
        { id: 35, attributes: { Title: "کیف دستی", Slug: "handbags" } },
      ],
    },
  },
};

const WITHOUT_CHILDREN: Category = {
  id: "13",
  attributes: { Title: "اکسسوری", Slug: "accessories", children: { data: [] } },
};

describe("category hierarchy wording", () => {
  it("describes the action as subcategories, not children", () => {
    render(<MobileTable data={[CATEGORY]} />);

    expect(screen.getByRole("button", { name: "مشاهده زیردسته‌ها" })).toBeInTheDocument();
    expect(screen.getByText("۲ زیردسته".replace("۲", "2"))).toBeInTheDocument();
    expect(screen.queryByText(/فرزند/)).not.toBeInTheDocument();
  });

  it("says a category has no subcategories rather than 'no children'", () => {
    render(<MobileTable data={[WITHOUT_CHILDREN]} />);

    expect(screen.getByRole("button", { name: "بدون زیردسته" })).toBeInTheDocument();
    expect(screen.queryByText(/فرزند/)).not.toBeInTheDocument();
  });

  it("names the parent on each subcategory once opened", async () => {
    render(<MobileTable data={[CATEGORY]} />);

    await userEvent.click(screen.getByRole("button", { name: "مشاهده زیردسته‌ها" }));

    expect(screen.getByText("زیردسته‌های کیف و کفش")).toBeInTheDocument();
    expect(screen.getAllByText("زیردستهٔ کیف و کفش")).toHaveLength(2);
    expect(screen.getByText("کفش زنانه")).toBeInTheDocument();
  });

  it("reports expanded state on the disclosure control", async () => {
    render(<MobileTable data={[CATEGORY]} />);

    const trigger = screen.getByRole("button", { name: "مشاهده زیردسته‌ها" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });
});
