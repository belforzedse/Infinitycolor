import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import PLPHeaderDesktopNav from "../DesktopNav";
import { useProductCategories } from "@/hooks/useProductCategories";
import type { ProductCategorySummary } from "@/services/product/categories";

let mockPathname = "/";
let mockSearch = "";

jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

jest.mock("@/hooks/useProductCategories", () => ({
  useProductCategories: jest.fn(),
}));

const mockedUseProductCategories = useProductCategories as jest.MockedFunction<
  typeof useProductCategories
>;

const category = (
  id: number,
  name: string,
  slug: string,
  children: ProductCategorySummary[] = [],
): ProductCategorySummary => ({
  id,
  name,
  slug,
  imageUrl: null,
  imageAlt: name,
  megaMenuImageUrl: null,
  megaMenuImageAlt: name,
  parentId: null,
  isMainCategory: true,
  hasChildren: children.length > 0,
  featured: false,
  children,
});

const catalog = [
  category(1, "پلیور", "پلیور-و-بافت"),
  category(2, "بامبر", "بامبر"),
  category(3, "کاپشن و پافر", "jacket-and-puffer"),
  category(4, "هودی", "hoodie-and-dores", [category(41, "سویشرت", "sweatshirt")]),
  category(5, "دورس", "دورس"),
  category(6, "پالتو", "coat", [category(61, "شکت", "shacket")]),
  category(7, "مانتو", "coat-and-mantle", [category(71, "مانتو کتی", "coat-blazer")]),
  category(8, "پیراهن", "shirt", [category(81, "پیراهن نخی", "cotton-dress")]),
  category(9, "شومیز", "paperback-and-tonic"),
  category(10, "شلوار", "pants", [category(101, "شلوار جین", "jeans")]),
  category(11, "شلوارک", "شوارک"),
  category(12, "دامن", "skirt", [category(121, "دامن بلند", "long-skirt")]),
  category(13, "انواع کفش", "shoes"),
  category(14, "شال", "shawls-and-scarves", [
    category(141, "شال نخی", "cotton-shawl"),
    category(142, "کلاه", "کلاه"),
  ]),
  category(15, "جوراب", "socks", [category(151, "جوراب مچی", "ankle-socks")]),
  category(16, "کمربند زنانه", "womens-belt"),
  category(17, "لباس زیر", "under-wear", [
    category(171, "نیم تنه کبریتی", "match-bust"),
    category(172, "لگ", "لگ"),
  ]),
  category(18, "کیف", "کیف"),
];

describe("PLPHeaderDesktopNav", () => {
  beforeEach(() => {
    mockPathname = "/";
    mockSearch = "";
    mockedUseProductCategories.mockReturnValue({
      categories: catalog,
      isLoading: false,
      error: null,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("uses the cached catalog tree and matches the mobile top-level order", () => {
    render(<PLPHeaderDesktopNav />);

    expect(mockedUseProductCategories).toHaveBeenCalledWith({
      navigationSource: "catalog",
      includeChildren: true,
    });

    const nav = screen.getByLabelText("منوی اصلی فروشگاه");
    const labels = Array.from(nav.querySelectorAll("a, button")).map((node) =>
      node.textContent?.trim(),
    );
    expect(labels).toEqual([
      "خانه",
      "فروشگاه",
      "بالا تنه",
      "پایین تنه",
      "کفش",
      "شال",
      "کلاه",
      "جوراب",
      "کمربند",
      "لباس ورزشی",
      "لباس زیر",
      "کیف",
      "Oppsi",
      "تخفیف‌ها",
      "مقالات",
    ]);
  });

  it("keeps leaves as links and opens category groups as dropdowns", () => {
    render(<PLPHeaderDesktopNav />);

    expect(screen.getByRole("link", { name: "کفش" })).toHaveAttribute(
      "href",
      "/plp/category/shoes",
    );
    expect(screen.queryByRole("button", { name: "کفش" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "کیف" })).toHaveAttribute(
      "href",
      `/plp/category/${encodeURIComponent("کیف")}`,
    );

    const upperBody = screen.getByRole("button", { name: "بالا تنه" });
    expect(upperBody).toHaveAttribute("aria-expanded", "false");
    fireEvent.pointerEnter(upperBody);

    expect(upperBody).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("desktop-mega-menu")).toBeInTheDocument();
    expect(screen.getByAltText("بالا تنه")).toHaveAttribute(
      "src",
      expect.stringContaining("upper-body.webp"),
    );
  });

  it("opens synthetic nested groups without an invented aggregate link", () => {
    render(<PLPHeaderDesktopNav />);
    fireEvent.pointerEnter(screen.getByRole("button", { name: "بالا تنه" }));

    const links = screen.getByTestId("desktop-mega-menu-links");
    const coatBomber = within(links).getByRole("button", { name: "کت و بامبر" });
    fireEvent.pointerEnter(coatBomber);

    const flyout = screen.getByTestId("desktop-mega-menu-flyout");
    expect(within(flyout).getByRole("link", { name: "بامبر" })).toHaveAttribute(
      "href",
      `/plp/category/${encodeURIComponent("بامبر")}`,
    );
    expect(within(flyout).getByRole("link", { name: "کاپشن و پافر" })).toHaveAttribute(
      "href",
      "/plp/category/jacket-and-puffer",
    );
    expect(within(flyout).queryByRole("link", { name: /مشاهده همه/ })).not.toBeInTheDocument();
  });

  it("opens real nested categories with view-all and child destinations", () => {
    render(<PLPHeaderDesktopNav />);
    fireEvent.click(screen.getByRole("button", { name: "بالا تنه" }));

    const shirt = within(screen.getByTestId("desktop-mega-menu-links")).getByRole("button", {
      name: "پیراهن",
    });
    fireEvent.focus(shirt);

    const flyout = screen.getByTestId("desktop-mega-menu-flyout");
    expect(within(flyout).getByRole("link", { name: "مشاهده همه پیراهن‌ها" })).toHaveAttribute(
      "href",
      "/plp/category/shirt",
    );
    expect(within(flyout).getByRole("link", { name: "پیراهن نخی" })).toHaveAttribute(
      "href",
      "/plp/category/cotton-dress",
    );
  });

  it("closes a nested flyout before closing the main dropdown on Escape", async () => {
    render(<PLPHeaderDesktopNav />);
    fireEvent.click(screen.getByRole("button", { name: "بالا تنه" }));
    fireEvent.focus(
      within(screen.getByTestId("desktop-mega-menu-links")).getByRole("button", {
        name: "پیراهن",
      }),
    );

    fireEvent.keyDown(screen.getByTestId("desktop-mega-menu"), { key: "Escape" });
    expect(screen.getByTestId("desktop-mega-menu")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByTestId("desktop-mega-menu-flyout")).not.toBeInTheDocument();
    });

    fireEvent.keyDown(screen.getByLabelText("منوی اصلی فروشگاه"), { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("desktop-mega-menu")).not.toBeInTheDocument();
    });
  });

  it("closes the dropdown when the pointer leaves the navigation region", async () => {
    render(<PLPHeaderDesktopNav />);
    fireEvent.pointerEnter(screen.getByRole("button", { name: "بالا تنه" }));
    fireEvent.pointerLeave(screen.getByTestId("desktop-nav-root"));

    await waitFor(() => {
      expect(screen.queryByTestId("desktop-mega-menu")).not.toBeInTheDocument();
    });
  });

  it("marks only the matching fixed PLP destination as current", () => {
    mockPathname = "/plp";
    mockSearch = "search=Oppsi";
    render(<PLPHeaderDesktopNav />);

    expect(screen.getByRole("link", { name: "Oppsi" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /تخفیف‌ها/ })).not.toHaveAttribute("aria-current");
  });
});
