import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PLPHeaderDesktopNav from "../DesktopNav";
import { useProductCategories } from "@/hooks/useProductCategories";

jest.mock("next/navigation", () => ({
  usePathname: () => "/",
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
  ],
};

describe("PLPHeaderDesktopNav", () => {
  beforeEach(() => {
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
    expect(screen.getByRole("link", { name: "پیراهن" })).toHaveAttribute(
      "href",
      "/plp/category/dress",
    );
    expect(screen.getByAltText("Megamenu image")).toBeInTheDocument();
    expect(screen.getByTestId("sale-badge-icon")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByLabelText("منوی اصلی فروشگاه"), { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByTestId("desktop-mega-menu")).not.toBeInTheDocument();
    });
  });

  it("closes the megamenu when the pointer leaves the navigation region", async () => {
    render(<PLPHeaderDesktopNav />);

    fireEvent.pointerEnter(screen.getByTestId("desktop-nav-category"));
    expect(screen.getByTestId("desktop-mega-menu")).toBeInTheDocument();

    fireEvent.pointerLeave(screen.getByTestId("desktop-nav-root"));

    await waitFor(() => {
      expect(screen.queryByTestId("desktop-mega-menu")).not.toBeInTheDocument();
    });
  });
});
