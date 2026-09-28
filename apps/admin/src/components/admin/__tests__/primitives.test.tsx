import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const push = jest.fn();
let mockPathname = "/sales";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, back: jest.fn(), replace: jest.fn() }),
  usePathname: () => mockPathname,
}));

import StatusBadge from "../StatusBadge";
import SubNav from "../SubNav";
import { ResourceList, ResourceListItem } from "../ResourceList";
import { EmptyState, FilteredEmptyState, ErrorState } from "../states";

describe("StatusBadge", () => {
  // The tone -> colour mapping used to be duplicated as hand-written switch
  // statements per screen, so the same status rendered in different colours.
  it.each([
    ["success", "text-green-700"],
    ["warning", "text-amber-700"],
    ["danger", "text-red-700"],
    ["info", "text-blue-700"],
    ["neutral", "text-slate-600"],
  ] as const)("maps the %s tone to a single colour", (tone, expected) => {
    const { container } = render(<StatusBadge label="وضعیت" tone={tone} />);
    expect(container.firstChild).toHaveClass(expected);
  });

  it("defaults to the neutral tone", () => {
    const { container } = render(<StatusBadge label="نامشخص" />);
    expect(container.firstChild).toHaveClass("text-slate-600", "rounded-pill");
  });
});

describe("ResourceListItem", () => {
  beforeEach(() => push.mockReset());

  it("activates from anywhere on the card, not just a chevron", async () => {
    const user = userEvent.setup();
    render(
      <ResourceList>
        <ResourceListItem href="/orders/edit/58342" title="علی احمدی" />
      </ResourceList>,
    );

    await user.click(screen.getByText("علی احمدی"));
    expect(push).toHaveBeenCalledWith("/orders/edit/58342");
  });

  it("is keyboard operable with Enter and Space", async () => {
    const user = userEvent.setup();
    const onActivate = jest.fn();
    render(
      <ResourceList>
        <ResourceListItem onActivate={onActivate} title="علی احمدی" />
      </ResourceList>,
    );

    const row = screen.getByRole("button");
    row.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");

    expect(onActivate).toHaveBeenCalledTimes(2);
  });

  it("keeps nested controls independent of row activation", async () => {
    const user = userEvent.setup();
    const onSelectionChange = jest.fn();
    const onAction = jest.fn();

    render(
      <ResourceList>
        <ResourceListItem
          href="/orders/edit/1"
          title="علی احمدی"
          selection={{ checked: false, onChange: onSelectionChange }}
          actions={
            <button type="button" onClick={onAction}>
              چاپ
            </button>
          }
        />
      </ResourceList>,
    );

    await user.click(screen.getByRole("checkbox"));
    expect(onSelectionChange).toHaveBeenCalledWith(true);
    expect(push).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "چاپ" }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it("renders a controlled selection checkbox", () => {
    render(
      <ResourceList>
        <ResourceListItem
          title="علی احمدی"
          selection={{ checked: true, onChange: jest.fn() }}
        />
      </ResourceList>,
    );

    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("is not interactive when no destination is given", () => {
    render(
      <ResourceList>
        <ResourceListItem title="علی احمدی" />
      </ResourceList>,
    );

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("stacks row actions under the identity so long labels cannot collapse the title", () => {
    render(
      <ResourceList>
        <ResourceListItem
          href="/orders/edit/1"
          title="امیرمهدی شاهرخی"
          badge={<span>لغو شده</span>}
          actions={
            <button type="button">ابتدا سفارش را آماده‌سازی کنید</button>
          }
        />
      </ResourceList>,
    );

    const card = screen.getByRole("button", { name: /امیرمهدی شاهرخی/ });
    expect(card).toHaveClass("flex-col");
    expect(
      card.querySelector(".w-full.min-w-0.flex-wrap.items-center.justify-end"),
    ).not.toBeNull();
    expect(screen.getByText("امیرمهدی شاهرخی")).toHaveClass(
      "min-w-0",
      "break-words",
    );
  });
});

describe("SubNav", () => {
  const items = [
    { id: "/sales", label: "نمای کلی", href: "/sales" },
    { id: "/sales/breakdown", label: "تفکیک فروش", href: "/sales/breakdown" },
  ];

  it("marks the route-matched tab as current", () => {
    mockPathname = "/sales/breakdown";
    render(<SubNav items={items} />);

    expect(screen.getByRole("link", { name: "تفکیک فروش" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "نمای کلی" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("matches a tab whose link carries query state by its path", () => {
    mockPathname = "/sales/breakdown";
    render(
      <SubNav
        items={[
          { id: "/sales", label: "نمای کلی", href: "/sales?start=2026-09-20" },
          {
            id: "/sales/breakdown",
            label: "تفکیک فروش",
            href: "/sales/breakdown?start=2026-09-20",
          },
        ]}
      />,
    );

    expect(screen.getByRole("link", { name: "تفکیک فروش" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "نمای کلی" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("does not mark a parent route active for a deeper sibling", () => {
    // "/sales" must not light up for "/sales/breakdown" just by prefix.
    mockPathname = "/sales/breakdown";
    render(<SubNav items={items} />);

    const overview = screen.getByRole("link", { name: "نمای کلی" });
    expect(overview).not.toHaveAttribute("aria-current");
  });

  it("renders nothing when the role filter removed every tab", () => {
    const { container } = render(<SubNav items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps tabs in one horizontally scrollable row instead of wrapping", () => {
    const { container } = render(
      <SubNav
        items={[
          ...items,
          { id: "/sales/traffic", label: "ترافیک", href: "/sales/traffic" },
          { id: "/sales/carts", label: "سبدهای رهاشده", href: "/sales/carts" },
        ]}
      />,
    );

    const nav = screen.getByRole("navigation", { name: "بخش‌ها" });
    const list = container.querySelector("ul");
    expect(nav.className).toMatch(/overflow-x-auto/);
    expect(list).toHaveClass("min-w-max", "flex-nowrap");
    expect(list?.className).not.toMatch(/flex-wrap/);
  });
});

describe("collection states", () => {
  it("distinguishes an empty resource from a filtered-out one", async () => {
    const user = userEvent.setup();
    const onClearFilters = jest.fn();

    const { rerender } = render(<EmptyState />);
    expect(screen.getByText("هنوز موردی ثبت نشده است")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "حذف فیلترها" }),
    ).not.toBeInTheDocument();

    rerender(<FilteredEmptyState onClearFilters={onClearFilters} />);
    expect(screen.getByText("موردی با این جستجو پیدا نشد")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "حذف فیلترها" }));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it("offers a retry on error", async () => {
    const user = userEvent.setup();
    const onRetry = jest.fn();

    render(<ErrorState description="اتصال برقرار نشد" onRetry={onRetry} />);

    expect(screen.getByText("اتصال برقرار نشد")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
