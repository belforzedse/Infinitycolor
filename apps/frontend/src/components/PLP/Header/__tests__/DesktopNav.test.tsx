import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import PLPHeaderDesktopNav from "../DesktopNav";
import { useProductCategories } from "@/hooks/useProductCategories";

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

const category = {
  id: 1,
  name: "لباس",
  slug: "clothing",
  imageUrl: "/images/categories/dress.webp",
  imageAlt: "Category image",
  imageWidth: null,
  imageHeight: null,
  megaMenuImageUrl: "/images/categories/dress.webp",
  megaMenuImageAlt: "Megamenu image",
  megaMenuImageWidth: 363,
  megaMenuImageHeight: 430,
  parentId: null,
  isMainCategory: true,
  hasChildren: true,
  featured: false,
  children: [
    {
      id: 2,
      name: "پیراهن",
      slug: "dress",
      imageUrl: null,
      imageAlt: "پیراهن",
      megaMenuImageUrl: null,
      megaMenuImageAlt: "پیراهن",
      parentId: 1,
      isMainCategory: false,
      featured: false,
    },
    {
      id: 3,
      name: "شال",
      slug: "shawls-and-scarves",
      imageUrl: null,
      imageAlt: "شال",
      megaMenuImageUrl: null,
      megaMenuImageAlt: "شال",
      parentId: 1,
      isMainCategory: false,
      featured: false,
    },
  ],
};

describe("PLPHeaderDesktopNav", () => {
  beforeEach(() => {
    mockPathname = "/";
    mockSearch = "";
    mockedUseProductCategories.mockReturnValue({
      categories: [category],
      isLoading: false,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("fetches desktop categories with children for the megamenu", () => {
    render(<PLPHeaderDesktopNav />);

    expect(mockedUseProductCategories).toHaveBeenCalledWith({
      navbarAssignedOnly: true,
      includeChildren: true,
    });
  });

  it("opens category megamenu with child links and closes on Escape", async () => {
    render(<PLPHeaderDesktopNav />);

    expect(screen.queryByTestId("desktop-mega-menu")).not.toBeInTheDocument();

    fireEvent.pointerEnter(screen.getByText("لباس"));

    expect(screen.getByTestId("desktop-mega-menu")).toBeInTheDocument();
    expect(screen.getByTestId("desktop-mega-menu-backdrop")).toBeInTheDocument();
    expect(screen.getByTestId("desktop-mega-menu-links")).toHaveClass("grid-cols-3");
    expect(screen.getByTestId("desktop-mega-menu-links")).toHaveClass("overflow-visible");
    expect(screen.getByTestId("desktop-mega-menu-links")).not.toHaveClass("overflow-y-auto");
    expect(screen.getByRole("link", { name: "پیراهن" })).toHaveAttribute(
      "href",
      "/plp/category/dress",
    );
    expect(within(screen.getByTestId("desktop-mega-menu-links")).queryByRole("link", { name: "کمربند" })).not.toBeInTheDocument();
    expect(screen.getByAltText("Megamenu image")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Oppsi" })).toHaveAttribute(
      "href",
      "/plp?search=Oppsi",
    );
    expect(screen.getByTestId("sale-badge-icon")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByLabelText("منوی اصلی فروشگاه"), { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByTestId("desktop-mega-menu")).not.toBeInTheDocument();
    });
  });

  it("closes the megamenu when the pointer leaves the navigation region", async () => {
    render(<PLPHeaderDesktopNav />);

    fireEvent.pointerEnter(screen.getByRole("link", { name: "لباس" }));
    expect(screen.getByTestId("desktop-mega-menu")).toBeInTheDocument();

    fireEvent.pointerLeave(screen.getByTestId("desktop-nav-root"));

    await waitFor(() => {
      expect(screen.queryByTestId("desktop-mega-menu")).not.toBeInTheDocument();
    });
  });

  it("adds کمربند as a top-level header category", () => {
    render(<PLPHeaderDesktopNav />);

    const nav = screen.getByLabelText("منوی اصلی فروشگاه");
    const beltLink = within(nav).getByRole("link", { name: "کمربند" });
    expect(beltLink).toHaveAttribute("href", "/plp/category/womens-belt");

    fireEvent.pointerEnter(beltLink);
    expect(
      within(screen.getByTestId("desktop-mega-menu-links")).getByRole("link", { name: "کمربند" }),
    ).toHaveAttribute("href", "/plp/category/womens-belt");
    expect(screen.getByRole("img", { name: "کمربند" })).toHaveAttribute(
      "src",
      expect.stringContaining("womens-belt.jpg"),
    );
  });

  it("labels discounts as تخفیف‌ها and does not show model hiring", () => {
    render(<PLPHeaderDesktopNav />);
    const nav = screen.getByLabelText("منوی اصلی فروشگاه");
    const items = Array.from(nav.querySelectorAll("a, button"));
    expect(screen.getByRole("link", { name: /تخفیف‌ها/ })).toHaveAttribute(
      "href",
      "/plp?hasDiscount=true",
    );
    expect(screen.queryByRole("link", { name: /جشنواره‌ها/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "استخدام مدل" })).not.toBeInTheDocument();
    expect(screen.queryByText("استخدام مدل")).not.toBeInTheDocument();
    expect(items.at(-1)).toHaveTextContent("مقالات");
  });

  it("does not mark Oppsi or discounts as the current page on a bare /plp visit", () => {
    mockPathname = "/plp";
    mockSearch = "";
    render(<PLPHeaderDesktopNav />);

    expect(screen.getByRole("link", { name: "Oppsi" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: /تخفیف‌ها/ })).not.toHaveAttribute("aria-current");
  });

  it("marks only the matching PLP query destination as current", () => {
    mockPathname = "/plp";
    mockSearch = "search=Oppsi";
    const { unmount } = render(<PLPHeaderDesktopNav />);

    expect(screen.getByRole("link", { name: "Oppsi" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /تخفیف‌ها/ })).not.toHaveAttribute("aria-current");
    unmount();

    mockSearch = "hasDiscount=true";
    render(<PLPHeaderDesktopNav />);
    expect(screen.getByRole("link", { name: "Oppsi" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: /تخفیف‌ها/ })).toHaveAttribute("aria-current", "page");
  });
});
