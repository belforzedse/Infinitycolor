import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
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
});
