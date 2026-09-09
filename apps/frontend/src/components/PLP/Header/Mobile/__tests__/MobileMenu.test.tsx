import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import MobileMenu from "../MobileMenu";
import { modelHiringModalOpenAtom } from "@/atoms/modelHiring";
import jotaiStore from "@/lib/jotaiStore";
import { useProductCategories } from "@/hooks/useProductCategories";

const pushMock = jest.fn();

jest.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: pushMock }),
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
        category(8, "مانتو", "coat-and-mantle", [
          category(9, "مانتو کتی", "coat-blazer"),
        ]),
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
    expect(within(upperBodyGroup).getByRole("link", { name: "مشاهده همه مانتو‌ها" })).toHaveAttribute(
      "href",
      "/plp/category/coat-and-mantle",
    );
    expect(within(upperBodyGroup).getByRole("link", { name: "مانتو کتی" })).toHaveAttribute(
      "href",
      "/plp/category/coat-blazer",
    );
  });

  it("adds کمربند as a top-level accessories category", async () => {
    render(<MobileMenu isOpen onClose={jest.fn()} />);

    const accessoriesButton = await screen.findByRole("button", { name: "کفش و اکسسوری" });
    fireEvent.click(accessoriesButton);

    const accessoriesGroup = screen.getByTestId("category-group-shoes-accessories");
    expect(within(accessoriesGroup).getByRole("link", { name: "کمربند" })).toHaveAttribute(
      "href",
      "/plp/category/womens-belt",
    );
  });

  it("adds a hardcoded Oppsi search link outside the grouped categories", async () => {
    render(<MobileMenu isOpen onClose={jest.fn()} />);

    const oppsiLink = await screen.findByRole("link", { name: "Oppsi" });
    expect(oppsiLink).toHaveAttribute("href", "/plp?search=Oppsi");
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

  it("places model hiring as the last item in the mobile header menu", async () => {
    render(<MobileMenu isOpen onClose={jest.fn()} />);
    const nav = await screen.findByLabelText("منوی موبایل فروشگاه");
    expect(nav.lastElementChild).toHaveTextContent("استخدام مدل");
    expect(screen.getByRole("button", { name: "استخدام مدل" })).toBeInTheDocument();
  });

  it("opens model hiring only after the menu finishes closing", async () => {
    const onClose = jest.fn();
    jotaiStore.set(modelHiringModalOpenAtom, false);

    render(<MobileMenu isOpen onClose={onClose} />);

    fireEvent.pointerDown(await screen.findByRole("button", { name: "استخدام مدل" }));

    expect(onClose).not.toHaveBeenCalled();
    expect(jotaiStore.get(modelHiringModalOpenAtom)).toBe(false);
    expect(screen.getByLabelText("منوی موبایل فروشگاه")).toBeInTheDocument();

    fireEvent.animationEnd(document.querySelector(".storefront-mobile-menu-panel") as HTMLElement);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("منوی موبایل فروشگاه")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(jotaiStore.get(modelHiringModalOpenAtom)).toBe(true);
    });
  });

  describe("inline search", () => {
    const mockSearchResponse = (items: unknown[]) => {
      global.fetch = jest.fn().mockResolvedValue({
        json: async () => ({ data: items }),
      }) as unknown as typeof fetch;
    };

    it("shows product results and hides the menu while searching", async () => {
      mockSearchResponse([
        {
          id: 101,
          attributes: { Slug: "blue-bag", Title: "کیف آبی", Price: 200000, IsAvailable: true },
        },
      ]);

      render(<MobileMenu isOpen onClose={jest.fn()} />);
      await screen.findByRole("button", { name: "بالاتنه" });

      const input = screen.getByLabelText("جستجوی محصولات");
      fireEvent.change(input, { target: { value: "کیف" } });

      // Menu items are hidden as soon as a query is present.
      expect(
        screen.queryByRole("navigation", { name: "منوی موبایل فروشگاه" }),
      ).not.toBeInTheDocument();

      // Debounced product result renders.
      const result = await screen.findByRole("option");
      expect(result).toHaveAttribute("title", "کیف آبی");
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/products/search?q=%DA%A9%DB%8C%D9%81"),
        expect.objectContaining({ cache: "no-store" }),
      );
    });

    it("restores the menu when the search field is cleared", async () => {
      mockSearchResponse([
        { id: 101, attributes: { Slug: "blue-bag", Title: "کیف آبی", Price: 200000 } },
      ]);

      render(<MobileMenu isOpen onClose={jest.fn()} />);
      await screen.findByRole("button", { name: "بالاتنه" });

      const input = screen.getByLabelText("جستجوی محصولات");
      fireEvent.change(input, { target: { value: "کیف" } });
      await screen.findByRole("option");

      fireEvent.click(screen.getByRole("button", { name: "پاک کردن جستجو" }));

      expect(await screen.findByRole("button", { name: "بالاتنه" })).toBeInTheDocument();
      expect(screen.queryByRole("option")).not.toBeInTheDocument();
    });

    it("shows a friendly empty state when there are no results", async () => {
      mockSearchResponse([]);

      render(<MobileMenu isOpen onClose={jest.fn()} />);
      await screen.findByRole("button", { name: "بالاتنه" });

      const input = screen.getByLabelText("جستجوی محصولات");
      fireEvent.change(input, { target: { value: "qqq" } });

      expect(await screen.findByText("موردی یافت نشد")).toBeInTheDocument();
    });

    it("focuses the search field when opened with focusSearchOnOpen", async () => {
      jest.useFakeTimers();

      render(<MobileMenu isOpen focusSearchOnOpen onClose={jest.fn()} />);
      await screen.findByRole("button", { name: "بالاتنه" });

      const input = screen.getByLabelText("جستجوی محصولات");
      expect(input).not.toHaveFocus();

      jest.advanceTimersByTime(150);

      expect(input).toHaveFocus();

      jest.useRealTimers();
    });
  });
});
