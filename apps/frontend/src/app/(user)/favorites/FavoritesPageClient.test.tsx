import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import FavoritesPage from "./FavoritesPageClient";
import ProductLikeService from "@/services/product/product-like";
import { currentUserAtom } from "@/lib/atoms/auth";
import type { MeResponse } from "@/services/user/me";
import {
  likedProductsAtom,
  likedProductsLoadedAtom,
  likedProductsOwnerAtom,
} from "@/hooks/useProductLike";
jest.mock("@/services/product/product", () => ({
  calculateUniqueColorsCount: jest.fn(() => 0),
  getUniqueColorCodes: jest.fn(() => []),
}));
jest.mock("@/services/product/product-like", () => ({
  __esModule: true,
  default: { getUserFavorites: jest.fn() },
}));

jest.mock("@/components/Product/SmallCard", () => ({
  __esModule: true,
  default: ({ id }: { id: number }) => <div data-testid="fav-card">{id}</div>,
}));

jest.mock("@/components/layout/UserContainer", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock("@/components/User/Account/QuickLinks", () => ({
  __esModule: true,
  default: () => <div />,
}));

jest.mock("@/components/storefront/StorefrontAccountShell", () => ({
  StorefrontAccountShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const getUserFavorites = ProductLikeService.getUserFavorites as jest.Mock;

const favorite = (productId: number) => ({
  id: productId,
  product: {
    id: productId,
    title: `Product ${productId}`,
    product_variations: [],
  },
});

const asUser = (id: number): MeResponse => ({
  id,
  Bio: null,
  BirthDate: null,
  FirstName: "Test",
  IsActive: true,
  IsVerified: true,
  LastName: "User",
  NationalCode: null,
  Phone: "09000000000",
  Sex: null,
  createdAt: "",
  updatedAt: "",
  isAdmin: false,
  roleName: "Customer",
});

function renderPage(store: ReturnType<typeof createStore>) {
  return render(
    <Provider store={store}>
      <FavoritesPage />
    </Provider>,
  );
}

describe("FavoritesPageClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows server-fetched favorites on a fresh visit, before useProductLike (mounted only by a rendered card) has populated the liked-products atom", async () => {
    // Regression: visibleFavorites used to require every favorite to already be
    // present in likedProductsAtom, but nothing on this page populates that atom
    // until a favorite card renders — and no card renders until visibleFavorites
    // is non-empty. That's a deadlock: a real favorite from the API was always
    // filtered out on first visit, and the page showed "no favorites" (reported bug).
    getUserFavorites.mockResolvedValue({
      data: [favorite(1), favorite(2)],
      meta: { pagination: { page: 1, pageSize: 12, pageCount: 1, total: 2 } },
    });

    const store = createStore();
    store.set(currentUserAtom, asUser(7));
    // Atom is deliberately left unloaded (likedProductsLoadedAtom defaults to false),
    // exactly as it is on a fresh page visit.

    renderPage(store);

    await waitFor(() => {
      expect(screen.getAllByTestId("fav-card")).toHaveLength(2);
    });
    expect(screen.queryByText("محصولی در لیست علاقه‌مندی‌ها وجود ندارد.")).not.toBeInTheDocument();
  });

  it("still hides a product optimistically un-liked elsewhere, once the atom has loaded for the current user", async () => {
    getUserFavorites.mockResolvedValue({
      data: [favorite(1), favorite(2)],
      meta: { pagination: { page: 1, pageSize: 12, pageCount: 1, total: 2 } },
    });

    const store = createStore();
    store.set(currentUserAtom, asUser(7));
    store.set(likedProductsOwnerAtom, 7);
    store.set(likedProductsLoadedAtom, true);
    store.set(likedProductsAtom, [
      { id: 1, product: { id: 1 }, createdAt: "", updatedAt: "" }, // product 2 was unliked
    ]);

    renderPage(store);

    await waitFor(() => {
      expect(screen.getAllByTestId("fav-card")).toHaveLength(1);
    });
  });

  it("does not trust a stale atom loaded for a different user", async () => {
    getUserFavorites.mockResolvedValue({
      data: [favorite(1)],
      meta: { pagination: { page: 1, pageSize: 12, pageCount: 1, total: 1 } },
    });

    const store = createStore();
    store.set(currentUserAtom, asUser(7));
    store.set(likedProductsOwnerAtom, 999); // a different, stale identity
    store.set(likedProductsLoadedAtom, true);
    store.set(likedProductsAtom, []);

    renderPage(store);

    await waitFor(() => {
      expect(screen.getAllByTestId("fav-card")).toHaveLength(1);
    });
  });
  it("shows all 37 favorites across pages even when the global likes cache only has the first 25", async () => {
    const allFavorites = Array.from({ length: 37 }, (_, index) => favorite(index + 1));

    getUserFavorites.mockImplementation(async (page = 1, pageSize = 12) => {
      const start = (page - 1) * pageSize;

      return {
        data: allFavorites.slice(start, start + pageSize),
        meta: {
          pagination: {
            page,
            pageSize,
            pageCount: 4,
            total: 37,
          },
        },
      };
    });

    const store = createStore();

    store.set(currentUserAtom, asUser(7));

    // Simulate the old incomplete global cache: only the first 25 likes exist.
    store.set(
      likedProductsAtom,
      Array.from({ length: 25 }, (_, index) => ({
        id: index + 1,
        product: { id: index + 1 },
        createdAt: "",
        updatedAt: "",
      })),
    );

    // The cache must not be trusted until the complete paginated load succeeds.
    store.set(likedProductsLoadedAtom, false);
    store.set(likedProductsOwnerAtom, 7);

    renderPage(store);

    const renderedIds = () =>
      screen.getAllByTestId("fav-card").map((card) => Number(card.textContent));

    await waitFor(() => {
      expect(renderedIds()).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    });

    fireEvent.click(screen.getByRole("button", { name: "بعدی" }));

    await waitFor(() => {
      expect(renderedIds()).toEqual(Array.from({ length: 12 }, (_, index) => index + 13));
    });

    fireEvent.click(screen.getByRole("button", { name: "بعدی" }));

    await waitFor(() => {
      expect(renderedIds()).toEqual(Array.from({ length: 12 }, (_, index) => index + 25));
    });

    fireEvent.click(screen.getByRole("button", { name: "بعدی" }));

    await waitFor(() => {
      expect(renderedIds()).toEqual([37]);
    });

    expect(getUserFavorites).toHaveBeenCalledWith(4, 12);
  });

  it("removes a favorite immediately when the completed likes cache changes", async () => {
    getUserFavorites.mockResolvedValue({
      data: [favorite(1), favorite(2)],
      meta: {
        pagination: {
          page: 1,
          pageSize: 12,
          pageCount: 1,
          total: 2,
        },
      },
    });

    const store = createStore();

    store.set(currentUserAtom, asUser(7));
    store.set(likedProductsOwnerAtom, 7);
    store.set(likedProductsLoadedAtom, true);
    store.set(likedProductsAtom, [
      {
        id: 1,
        product: { id: 1 },
        createdAt: "",
        updatedAt: "",
      },
      {
        id: 2,
        product: { id: 2 },
        createdAt: "",
        updatedAt: "",
      },
    ]);

    renderPage(store);

    await waitFor(() => {
      expect(screen.getAllByTestId("fav-card")).toHaveLength(2);
    });

    await act(async () => {
      store.set(
        likedProductsAtom,
        store.get(likedProductsAtom).filter((likedProduct) => likedProduct.product.id !== 2),
      );
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("fav-card")).toHaveLength(1);
    });

    expect(screen.getByTestId("fav-card")).toHaveTextContent("1");
  });
});
