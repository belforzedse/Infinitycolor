import { fireEvent, render, screen, within } from "@testing-library/react";
import MobileMenu from "../MobileMenu";
import { useProductCategories } from "@/hooks/useProductCategories";

jest.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

jest.mock("@/hooks/useProductCategories", () => ({
  useProductCategories: jest.fn(),
}));

jest.mock("@/contexts/CartContext", () => ({
  useCart: () => ({
    totalItems: 0,
    openDrawer: jest.fn(),
  }),
}));

jest.mock("@/hooks/useCartShellReady", () => ({
  useCartShellReady: () => true,
}));

const mockedUseProductCategories = useProductCategories as jest.MockedFunction<
  typeof useProductCategories
>;

const category = (id: number, name: string, slug: string, children = []) => ({
  id,
  name,
  slug,
  imageUrl: null,
  imageAlt: name,
  megaMenuImageUrl: null,
  megaMenuImageAlt: name,
  parentId: null,
  isMainCategory: true,
  featured: false,
  children,
});

describe("MobileMenu", () => {
  beforeEach(() => {
    mockedUseProductCategories.mockReturnValue({
      categories: [
        category(1, "پیراهن", "shirt"),
        category(2, "جوراب", "socks"),
        category(3, "انواع کفش", "shoes"),
        category(4, "دامن", "skirt"),
        category(5, "شال", "shawls-and-scarves"),
        category(6, "شلوار", "pants"),
        category(7, "شومیز", "paperback-and-tonic"),
        category(8, "مانتو", "coat-and-mantle", [category(9, "مانتو کتی", "coat-blazer")]),
        category(10, "راحتی", "house-dress"),
        category(11, "لباس زیر", "under-wear"),
        category(12, "لباس مردانه", "لباس-مردانه"),
        category(13, "لباس‌های زمستانه", "winter"),
        category(14, "کیف", "bags"),
      ],
      isLoading: false,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("fetches assigned navbar categories with children for the mobile menu", async () => {
    render(<MobileMenu isOpen onClose={jest.fn()} />);

    await screen.findByRole("button", { name: "بالاتنه" });

    expect(mockedUseProductCategories).toHaveBeenCalledWith({
      navbarAssignedOnly: true,
      includeChildren: true,
      enabled: true,
    });
  });

  it("groups mobile navbar categories and preserves nested category expansion", async () => {
    render(<MobileMenu isOpen onClose={jest.fn()} />);

    const upperBodyButton = await screen.findByRole("button", { name: "بالاتنه" });
    const upperBodyGroup = screen.getByTestId("category-group-upper-body");

    expect(screen.getByRole("button", { name: "پایین‌تنه" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "کفش و اکسسوری" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "سایر لباس‌ها" })).toBeInTheDocument();

    fireEvent.click(upperBodyButton);

    expect(upperBodyButton).toHaveAttribute("aria-expanded", "true");
    expect(within(upperBodyGroup).getByRole("link", { name: "پیراهن" })).toHaveAttribute(
      "href",
      "/plp/category/shirt",
    );
    expect(within(upperBodyGroup).getByRole("link", { name: "شومیز" })).toHaveAttribute(
      "href",
      "/plp/category/paperback-and-tonic",
    );

    const coatButton = within(upperBodyGroup).getByRole("button", { name: "مانتو" });
    fireEvent.click(coatButton);

    expect(coatButton).toHaveAttribute("aria-expanded", "true");
    expect(within(upperBodyGroup).getByRole("link", { name: "مانتو کتی" })).toHaveAttribute(
      "href",
      "/plp/category/coat-blazer",
    );
  });

  it("places unmatched navbar categories in the fallback mobile group", async () => {
    render(<MobileMenu isOpen onClose={jest.fn()} />);

    const otherButton = await screen.findByRole("button", { name: "سایر لباس‌ها" });
    fireEvent.click(otherButton);

    const otherGroup = screen.getByTestId("category-group-other-clothing");
    expect(within(otherGroup).getByRole("link", { name: "راحتی" })).toHaveAttribute(
      "href",
      "/plp/category/house-dress",
    );
    expect(within(otherGroup).getByRole("link", { name: "کیف" })).toHaveAttribute(
      "href",
      "/plp/category/bags",
    );
  });
});
