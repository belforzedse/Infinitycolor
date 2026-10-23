import { act, fireEvent, render, screen, within } from "@testing-library/react";
import MobileMenu from "../MobileMenu";
import { useProductCategories } from "@/hooks/useProductCategories";
const pushMock = jest.fn();

jest.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => new URLSearchParams(),
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
        category(5, "شال", "shawls-and-scarves", [
          category(50, "شال نخی", "cotton-shawl"),
          category(51, "کلاه", "کلاه"),
        ]),
        category(6, "شلوار", "pants", [category(61, "شلوار جین", "jeans")]),
        category(7, "شومیز", "paperback-and-tonic"),
        category(8, "مانتو", "coat-and-mantle", [category(9, "مانتو کتی", "coat-blazer")]),
        category(10, "راحتی", "house-dress"),
        category(11, "لباس زیر", "under-wear", [
          category(111, "نیم تنه کبریتی", "match-bust"),
          category(112, "لگ", "لگ"),
        ]),
        category(12, "لباس مردانه", "لباس-مردانه"),
        category(13, "لباس‌های زمستانه", "winter"),
        category(14, "کیف", "کیف"),
        category(15, "پلیور", "پلیور-و-بافت"),
        category(16, "هودی", "hoodie-and-dores"),
        category(17, "پالتو", "coat"),
        category(18, "بامبر", "بامبر"),
        category(19, "شلوارک", "شوارک"),
        category(20, "دورس", "دورس"),
      ],
      isLoading: false,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("fetches parent categories with children for the mobile menu", async () => {
    render(<MobileMenu isOpen onClose={jest.fn()} />);

    await screen.findByRole("button", { name: "بالا تنه" });

    expect(mockedUseProductCategories).toHaveBeenCalledWith({
      navigationSource: "catalog",
      includeChildren: true,
      enabled: true,
    });
  });

  it("groups mobile categories in the merchandising tree and preserves nested expansion", async () => {
    render(<MobileMenu isOpen onClose={jest.fn()} />);

    const upperBodyButton = await screen.findByRole("button", { name: "بالا تنه" });
    const upperBodyGroup = screen.getByTestId("category-group-upper-body");

    expect(screen.getByRole("button", { name: "پایین تنه" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "لباس ورزشی" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "کفش" })).toHaveAttribute(
      "href",
      "/plp/category/shoes",
    );
    expect(screen.getByRole("button", { name: "شال" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "کلاه" })).toHaveAttribute(
      "href",
      `/plp/category/${encodeURIComponent("کلاه")}`,
    );
    expect(screen.queryByRole("button", { name: "کفش و اکسسوری" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "سایر لباس‌ها" })).not.toBeInTheDocument();

    fireEvent.click(upperBodyButton);

    expect(upperBodyButton).toHaveAttribute("aria-expanded", "true");
    expect(within(upperBodyGroup).getByRole("link", { name: "پلیور" })).toHaveAttribute(
      "href",
      `/plp/category/${encodeURIComponent("پلیور-و-بافت")}`,
    );
    expect(within(upperBodyGroup).getByRole("link", { name: "پیراهن" })).toHaveAttribute(
      "href",
      "/plp/category/shirt",
    );
    expect(within(upperBodyGroup).getByRole("link", { name: "شومیز و تونیک" })).toHaveAttribute(
      "href",
      "/plp/category/paperback-and-tonic",
    );

    const coatButton = within(upperBodyGroup).getByRole("button", { name: "پالتو و مانتو" });
    fireEvent.click(coatButton);

    expect(coatButton).toHaveAttribute("aria-expanded", "true");
    expect(
      within(upperBodyGroup).getByRole("link", {
        name: "مشاهده همه بالاتنه‌ها",
      }),
    ).toHaveAttribute("href", "/plp?menuGroup=upper-body");

    expect(within(upperBodyGroup).getByRole("link", { name: "پالتو" })).toHaveAttribute(
      "href",
      "/plp/category/coat",
    );
    expect(within(upperBodyGroup).getByRole("link", { name: "مانتو" })).toHaveAttribute(
      "href",
      "/plp/category/coat-and-mantle",
    );
    expect(within(upperBodyGroup).getByRole("link", { name: "مانتو کتی" })).toHaveAttribute(
      "href",
      "/plp/category/coat-blazer",
    );
  });
  it("shows view all links for lower body and sportswear", async () => {
    render(<MobileMenu isOpen onClose={jest.fn()} />);

    const groups = [
      {
        name: "پایین تنه",
        label: "مشاهده همه پایین‌تنه‌ها",
        href: "/plp?menuGroup=lower-body",
      },
      {
        name: "لباس ورزشی",
        label: "مشاهده همه لباس‌های ورزشی",
        href: "/plp?menuGroup=sportswear",
      },
    ];

    for (const group of groups) {
      const button = screen.getByRole("button", {
        name: group.name,
      });

      fireEvent.click(button);

      expect(button).toHaveAttribute("aria-expanded", "true");

      expect(
        screen.getByRole("link", {
          name: group.label,
        }),
      ).toHaveAttribute("href", group.href);
    }
  });
  it("adds کمربند as a standalone mobile category", async () => {
    render(<MobileMenu isOpen onClose={jest.fn()} />);

    expect(await screen.findByRole("link", { name: "کمربند" })).toHaveAttribute(
      "href",
      "/plp/category/womens-belt",
    );
  });

  it("adds a hardcoded Oppsi search link outside the grouped categories", async () => {
    render(<MobileMenu isOpen onClose={jest.fn()} />);

    const oppsiLink = await screen.findByRole("link", { name: "Oppsi" });
    expect(oppsiLink).toHaveAttribute("href", "/plp?search=Oppsi");
  });

  it("keeps کیف as an extra top-level category and hides unmatched clothing", async () => {
    render(<MobileMenu isOpen onClose={jest.fn()} />);

    expect(await screen.findByRole("link", { name: "کیف" })).toHaveAttribute(
      "href",
      `/plp/category/${encodeURIComponent("کیف")}`,
    );
    expect(screen.queryByRole("link", { name: "راحتی" })).not.toBeInTheDocument();
  });

  it("labels discounts as تخفیف‌ها and does not show model hiring", async () => {
    render(<MobileMenu isOpen onClose={jest.fn()} />);
    const nav = await screen.findByLabelText("منوی موبایل فروشگاه");
    expect(screen.getByRole("link", { name: /تخفیف‌ها/ })).toHaveAttribute(
      "href",
      "/plp?hasDiscount=true",
    );
    expect(screen.queryByRole("link", { name: /جشنواره‌ها/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "استخدام مدل" })).not.toBeInTheDocument();
    expect(screen.queryByText("استخدام مدل")).not.toBeInTheDocument();
    expect(nav.lastElementChild).toHaveTextContent("مقالات");
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
      await screen.findByRole("button", { name: "بالا تنه" });

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
      await screen.findByRole("button", { name: "بالا تنه" });

      const input = screen.getByLabelText("جستجوی محصولات");
      fireEvent.change(input, { target: { value: "کیف" } });
      await screen.findByRole("option");

      fireEvent.click(screen.getByRole("button", { name: "پاک کردن جستجو" }));

      expect(await screen.findByRole("button", { name: "بالا تنه" })).toBeInTheDocument();
      expect(screen.queryByRole("option")).not.toBeInTheDocument();
    });

    it("shows a friendly empty state when there are no results", async () => {
      mockSearchResponse([]);

      render(<MobileMenu isOpen onClose={jest.fn()} />);
      await screen.findByRole("button", { name: "بالا تنه" });

      const input = screen.getByLabelText("جستجوی محصولات");
      fireEvent.change(input, { target: { value: "qqq" } });

      expect(await screen.findByText("موردی یافت نشد")).toBeInTheDocument();
    });

    it("focuses the search field when opened with focusSearchOnOpen", async () => {
      jest.useFakeTimers();

      render(<MobileMenu isOpen focusSearchOnOpen onClose={jest.fn()} />);
      await screen.findByRole("button", { name: "بالا تنه" });

      const input = screen.getByLabelText("جستجوی محصولات");
      expect(input).not.toHaveFocus();

      act(() => {
        jest.advanceTimersByTime(150);
      });
      expect(input).toHaveFocus();

      jest.useRealTimers();
    });
  });

  // Reported in production: the hamburger opened once, then never again after
  // visiting any page from the menu. A nav link closes via onClose(), so the
  // parent flips `isOpen` false BEFORE the exit animation ends; finishMenuClose()
  // then latched a ref that only an `isOpen` transition cleared, and the latch
  // swallowed every later open for the rest of the session.
  it("opens again after a nav link closed it", async () => {
    const onClose = jest.fn();
    const { rerender } = render(<MobileMenu isOpen onClose={onClose} />);
    await screen.findByRole("button", { name: "بالا تنه" });

    const panel = document.querySelector(".storefront-mobile-menu-panel");
    expect(panel).not.toBeNull();

    // Nav link: isOpen flips first, the exit animation finishes afterwards.
    rerender(<MobileMenu isOpen={false} onClose={onClose} />);
    fireEvent.animationEnd(panel as Element);
    expect(document.querySelector(".storefront-mobile-menu-panel")).toBeNull();

    rerender(<MobileMenu isOpen onClose={onClose} />);
    await screen.findByRole("button", { name: "بالا تنه" });

    expect(document.querySelector(".storefront-mobile-menu-panel")).not.toBeNull();
  });
});
