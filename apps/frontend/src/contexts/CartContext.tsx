"use client";

import React, { createContext, useContext, useState, useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import toast from "react-hot-toast";
import { CartService } from "@/services";
import resolveAssetUrl from "@/utils/resolveAssetUrl";
import notify from "@/utils/notify";
import { cartRequestQueue } from "@/utils/requestQueue";
import { centralAuth, subscribeToAuthState } from "@/lib/central-auth";
import { hapticSuccess, hapticError } from "@/utils/haptics";
import { isOnline } from "@/utils/offlineQueue";
import { trackFunnelStep, trackAnalyticsEvent } from "@/lib/analytics";
import {
  CART_STOCK_LIMIT_MESSAGE,
  isCartStockLimitError,
  type CartStockNoticeState,
} from "@/utils/cartStock";

export interface CartItem {
  id: string;
  cartItemId?: string;
  slug: string;
  productId: string;
  variationId?: string;
  name: string;
  category: string;
  price: number;
  originalPrice?: number;
  discountPercentage?: number;
  quantity: number;
  image: string;
  color?: string;
  size?: string;
  model?: string;
  sku?: string;
  /** Latest known server/PDP stock snapshot; mutations remain server-authoritative. */
  availableStock?: number;
}

const cartLineMatches = (existing: CartItem, incoming: CartItem) => {
  if (existing.variationId || incoming.variationId) {
    return Boolean(
      existing.variationId &&
        incoming.variationId &&
        String(existing.variationId) === String(incoming.variationId),
    );
  }
  return existing.id === incoming.id;
};

const isStoredCartItem = (value: unknown): value is CartItem => {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<CartItem>;
  return (
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    typeof item.price === "number" &&
    Number.isFinite(item.price) &&
    typeof item.quantity === "number" &&
    Number.isInteger(item.quantity) &&
    item.quantity > 0
  );
};

const readGuestCart = (): CartItem[] => {
  try {
    const raw = localStorage.getItem("cart");
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      localStorage.removeItem("cart");
      return [];
    }
    // Drop only the lines that fail validation. A single malformed entry — a
    // NaN price serializes to null, so one variation with an unparsable Price
    // is enough — must not take the rest of the cart with it.
    const items = parsed.filter(isStoredCartItem);
    if (items.length !== parsed.length) {
      try {
        localStorage.setItem("cart", JSON.stringify(items));
      } catch {
        // A failed rewrite must not cost us the lines we just recovered.
      }
    }
    return items;
  } catch {
    try {
      localStorage.removeItem("cart");
    } catch {
      // Storage may be unavailable; an in-memory empty cart remains usable.
    }
    return [];
  }
};

interface CartContextType {
  cartItems: CartItem[];
  isDrawerOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
  addToCart: (item: CartItem) => void;
  removeFromCart: (id: string) => void;
  updateQuantity: (id: string, quantity: number) => void;
  clearCart: () => Promise<void>;
  totalItems: number;
  totalPrice: number;
  subtotalBeforeDiscount: number;
  cartDiscountTotal: number;
  isLoading: boolean;
  /** False until the first client-side cart init (token + API or localStorage) completes. */
  isCartReady: boolean;
  checkCartStock: () => Promise<boolean>;
  /** Re-fetch the cart from the server (no-op for guest carts). */
  refreshCart: () => Promise<void>;
  migrateLocalCartToApi: () => Promise<void>;
  /**
   * Set when the server corrected the cart on its own (stock moved underneath
   * it). Rendered as one inline banner rather than a blocking dialog, so the
   * shopper is told what changed without checkout being interrupted.
   */
  stockNotice: CartStockNoticeState | null;
  setStockNotice: (notice: CartStockNoticeState | null) => void;
  dismissStockNotice: () => void;
}

const CartContext = createContext<CartContextType | null>(null);

export const useCart = () => {
  const context = useContext(CartContext);
  if (!context) {
    throw new Error("useCart must be used within a CartProvider");
  }
  return context;
};

export const useOptionalCart = () => useContext(CartContext);

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  // Server-side cart corrections awaiting the shopper's eyes. Held here rather
  // than in the checkout form so the cart list and the bill can show the same
  // notice, and so it survives the step change between them.
  const [stockNotice, setStockNotice] = useState<CartStockNoticeState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isCartReady, setIsCartReady] = useState(false);
  const [initializedMode, setInitializedMode] = useState<"guest" | "account" | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null);
  const [sessionGeneration, setSessionGeneration] = useState(0);
  const cartInitGenerationRef = useRef(0);
  const pathname = usePathname();

  // Read login state on client after hydration to avoid SSR mismatch
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.pathname === "/auth/complete") return;

    let active = true;
    const updateLoginState = async (forceRefresh = false) => {
      const token = await centralAuth.tokenManager.getToken({ forceRefresh }).catch(() => null);
      if (active) {
        setIsLoggedIn(Boolean(token));
        if (forceRefresh) setSessionGeneration((generation) => generation + 1);
      }
    };
    void updateLoginState();
    const unsubscribe = subscribeToAuthState((event) => {
      if (event.type === "logout") {
        setIsLoggedIn(false);
        setSessionGeneration((generation) => generation + 1);
      } else {
        setCartItems([]);
        setIsCartReady(false);
        void updateLoginState(true);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  // Close drawer when path changes
  useEffect(() => {
    setIsDrawerOpen(false);
  }, [pathname]);

  /**
   * Surface a cart the server corrected on its own.
   *
   * `checkCartStock` is destructive — it deletes lines that currently read
   * available <= 0 and truncates lines that no longer fit — and availability is
   * `Count - reservedCount`, so another shopper's unpaid checkout hold is enough
   * to trigger it. The shopper has to be told, or their cart silently shrinks.
   *
   * Removed lines are named where the backend gave us a title; adjusted lines are
   * marked in place by `cartItemId`, so the notice only has to explain why.
   */
  const applyStockCorrectionNotice = React.useCallback(
    (result: {
      valid?: boolean;
      itemsAdjusted?: Array<{ cartItemId: number }>;
      itemsRemoved?: Array<{ productTitle?: string }>;
    }) => {
      const adjustedCartItemIds = (result?.itemsAdjusted ?? []).map((item) =>
        String(item.cartItemId),
      );
      const removedNames = (result?.itemsRemoved ?? []).map(
        (item) => item.productTitle || "این کالا",
      );
      if (adjustedCartItemIds.length === 0 && removedNames.length === 0) return;
      setStockNotice({ adjustedCartItemIds, removedNames });
    },
    [],
  );

  // Initialize cart based on authentication status (client-only)
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isLoggedIn === null) return;

    const generation = ++cartInitGenerationRef.current;
    const CART_INIT_TIMEOUT_MS = 20_000;
    setIsCartReady(false);
    setInitializedMode(null);

    const initializeCart = async () => {
      const loggedIn = isLoggedIn;

      try {
        if (loggedIn) {
          // Do not show or persist a previous identity's cart while the next
          // authenticated cart is resolving.
          setCartItems([]);
          setIsLoading(true);
          try {
            await Promise.race([
              (async () => {
                // The guest cart lives only in localStorage, and the central-auth
                // handoff (/auth/callback -> /auth/complete -> full page load) never
                // passes through the legacy login pages that used to trigger the merge,
                // so it was left orphaned. Running it here covers every entry point.
                // It is a no-op when there is no guest cart, and idempotent through
                // `guestCartMergeId` when the legacy pages call it too.
                await migrateLocalCartToApi();
                // This call is destructive server-side: it deletes cart lines
                // whose variation currently reads available <= 0 and rewrites the
                // quantity on lines that no longer fit. Discarding its result
                // meant items vanished from the shopper's cart with no message of
                // any kind — the checkout page reported the same corrections, but
                // this path, which runs on every login, said nothing.
                await CartService.checkCartStock()
                  .then((result) => {
                    if (generation !== cartInitGenerationRef.current) return;
                    applyStockCorrectionNotice(result);
                  })
                  .catch((error) => {
                    console.error("Failed to check cart stock:", error);
                  });
                await fetchUserCart(() => generation === cartInitGenerationRef.current);
              })(),
              new Promise<never>((_, reject) =>
                setTimeout(
                  () => reject(new Error("Cart initialization timed out")),
                  CART_INIT_TIMEOUT_MS,
                ),
              ),
            ]);
          } catch (error) {
            console.error("Logged-in cart initialization failed:", error);
          } finally {
            if (generation === cartInitGenerationRef.current) {
              setIsLoading(false);
            }
          }
        } else {
          setCartItems(readGuestCart());
        }
      } catch (error) {
        console.error("Failed to initialize cart:", error);
        if (loggedIn) {
          try {
            await fetchUserCart(() => generation === cartInitGenerationRef.current);
          } catch (fetchError) {
            console.error("Failed to fetch cart after error:", fetchError);
          }
        }
      } finally {
        if (generation === cartInitGenerationRef.current) {
          setInitializedMode(loggedIn ? "account" : "guest");
          setIsCartReady(true);
        }
      }
    };

    void initializeCart();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run when login mode changes; cart helpers are stable for the session
  }, [isLoggedIn, sessionGeneration]);

  // Save cart to localStorage when it changes (only for non-logged in users)
  useEffect(() => {
    if (!isCartReady || initializedMode !== "guest" || isLoggedIn !== false) return;

    try {
      localStorage.setItem("cart", JSON.stringify(cartItems));
    } catch {
      // Keep the guest cart usable in memory when storage is unavailable.
    }
  }, [cartItems, initializedMode, isLoggedIn, isCartReady]);

  // Fetch user's cart from API
  const fetchUserCart = async (shouldApply: () => boolean = () => true) => {
    try {
      setIsLoading(true);

      const data = await CartService.getUserCart();

      // Helper function to get image URL from CoverImage object
      const getImageUrl = (coverImage: any): string => {
        if (!coverImage) return "";

        // If medium format is available, use it, otherwise use the original.
        // resolveAssetUrl resolves relative/absolute Strapi uploads and applies
        // the media CDN origin when configured.
        const imageUrl = coverImage.formats?.medium?.url || coverImage.url;
        return resolveAssetUrl(imageUrl);
      };

      const parseNumericValue = (value: unknown): number | undefined => {
        if (value === null || value === undefined) return undefined;
        if (typeof value === "number") {
          return Number.isFinite(value) ? value : undefined;
        }
        if (typeof value === "string") {
          const cleaned = value.replace(/,/g, "").trim();
          if (!cleaned) return undefined;
          const parsed = parseFloat(cleaned);
          return Number.isNaN(parsed) ? undefined : parsed;
        }
        return undefined;
      };

      const extractGeneralDiscountPercent = (variation: any): number | undefined => {
        if (!variation) return undefined;

        const candidateGroups = [variation.general_discounts, variation.general_discount];

        for (const group of candidateGroups) {
          if (!group) continue;

          const nodes = Array.isArray(group)
            ? group
            : Array.isArray(group?.data)
              ? group.data
              : group?.data
                ? [group.data]
                : [group];

          for (const node of nodes) {
            const amount =
              node?.attributes?.Amount ?? node?.Amount ?? node?.attributes?.amount ?? node?.amount;
            const parsedAmount = parseNumericValue(amount);
            if (parsedAmount !== undefined) return parsedAmount;
          }
        }

        return undefined;
      };

      // Transform API cart format to local format
      const originalItemCount = data?.cart_items?.length || 0;
      const transformedItems: CartItem[] = (data?.cart_items ?? [])
        .map((item) => {
          const variation = item.product_variation;
          const product = variation?.product;

          // Skip items without product or variation
          if (!product || !variation) {
            console.warn("Skipping cart item with missing product/variation data:", {
              itemId: item.id,
              hasVariation: !!variation,
              hasProduct: !!product,
            });
            return null;
          }

          const productId = String(product.id || "");
          const compositeId = variation.id ? `${productId}-${variation.id}` : String(item.id);

          // Get image URL from CoverImage
          const imageUrl = getImageUrl(product.CoverImage);

          // Get category from product_main_category or fallback
          const category = product.product_main_category?.Title || "Unknown";

          // Parse price to ensure it's a number
          const basePrice = parseNumericValue(variation.Price) ?? 0;
          const listedDiscountPrice = parseNumericValue((variation as any)?.DiscountPrice);
          const generalDiscountPercent = extractGeneralDiscountPercent(variation);

          let finalUnitPrice = basePrice;
          if (
            listedDiscountPrice &&
            listedDiscountPrice > 0 &&
            (finalUnitPrice === 0 || listedDiscountPrice < finalUnitPrice)
          ) {
            finalUnitPrice = listedDiscountPrice;
          }

          if (
            generalDiscountPercent &&
            generalDiscountPercent > 0 &&
            generalDiscountPercent < 100 &&
            basePrice > 0
          ) {
            const computed = Math.round(basePrice * (1 - generalDiscountPercent / 100));
            if (computed > 0 && (finalUnitPrice === 0 || computed < finalUnitPrice)) {
              finalUnitPrice = computed;
            }
          }

          const lineSum = parseNumericValue(item.Sum);
          if (lineSum && item.Count && item.Count > 0) {
            const derivedUnitPrice = lineSum / item.Count;
            if (
              Number.isFinite(derivedUnitPrice) &&
              derivedUnitPrice > 0 &&
              (finalUnitPrice === 0 || derivedUnitPrice < finalUnitPrice)
            ) {
              finalUnitPrice = derivedUnitPrice;
            }
          }

          if (finalUnitPrice === 0 && listedDiscountPrice) {
            finalUnitPrice = listedDiscountPrice;
          }
          if (finalUnitPrice === 0 && basePrice > 0) {
            finalUnitPrice = basePrice;
          }

          const hasDiscount = basePrice > 0 && finalUnitPrice > 0 && finalUnitPrice < basePrice;
          const originalPrice = hasDiscount ? basePrice : undefined;
          const discountPercentage = hasDiscount
            ? Math.round(((basePrice - finalUnitPrice) / basePrice) * 100)
            : undefined;

          // Use product Slug if available, otherwise fall back to ID
          const productSlug = (product as { Slug?: string }).Slug || String(product.id);

          return {
            id: compositeId,
            cartItemId: String(item.id),
            slug: productSlug,
            productId,
            variationId: String(variation.id),
            name: product.Title,
            category: category,
            price: finalUnitPrice,
            originalPrice,
            discountPercentage,
            quantity: item.Count,
            image: imageUrl,
            color: variation.product_variation_color?.Title,
            size: variation.product_variation_size?.Title,
            model: variation.product_variation_model?.Title,
            sku: variation.SKU,
            availableStock: parseNumericValue(item.availableStock),
          };
        })
        .filter((item) => item !== null);

      // Notify user if items were removed due to missing data
      if (
        shouldApply() &&
        transformedItems.length < originalItemCount &&
        typeof window !== "undefined"
      ) {
        const removedCount = originalItemCount - transformedItems.length;
        console.warn(
          `${removedCount} item(s) were removed from cart due to missing product data. They may have been deleted.`,
        );
      }

      if (shouldApply()) {
        setCartItems(transformedItems);
      }
    } catch (error) {
      console.error("Failed to fetch cart:", error);
    } finally {
      if (shouldApply()) {
        setIsLoading(false);
      }
    }
  };

  // Function to migrate local cart to API when user logs in
  const pendingRemovals = useRef<Set<string>>(new Set());

  const migrateLocalCartToApi = async () => {
    if (typeof window === "undefined") return;

    // Read through the same validator the guest view uses, so the merge sees
    // exactly the lines the shopper was shown rather than raw storage.
    const localCartItems = readGuestCart();
    if (!localCartItems.length) return;

    try {
      setIsLoading(true);

      const deduped = new Map<string, CartItem>();
      for (const item of localCartItems) {
        const key = item.variationId || item.id;
        const existing = deduped.get(key);
        if (existing) {
          existing.quantity += item.quantity;
        } else {
          deduped.set(key, { ...item });
        }
      }

      const mergeItems = Array.from(deduped.values())
        .filter((item) => item.variationId && Number.isInteger(Number(item.variationId)))
        .map((item) => ({ productVariationId: Number(item.variationId), quantity: item.quantity }));
      if (!mergeItems.length) {
        // Nothing is mergeable without a variation id, and the stored cart
        // stays put, so this would otherwise retry silently on every init.
        console.warn("Guest cart has no variation ids to merge; leaving it in local storage.");
        return;
      }
      let mergeId = localStorage.getItem("guestCartMergeId");
      if (!mergeId) {
        mergeId =
          globalThis.crypto?.randomUUID?.() ||
          `merge-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        localStorage.setItem("guestCartMergeId", mergeId);
      }
      const result = await CartService.mergeGuestCart(mergeId, mergeItems);
      const adjusted = result.adjusted ?? [];
      const rejected = result.rejected ?? [];
      const landed = (result.accepted ?? []).length + adjusted.length;
      localStorage.removeItem("cart");
      localStorage.removeItem("guestCartMergeId");
      // Always report, replay included: a replay only reaches us after a lost
      // response told the shopper their items were preserved, so staying quiet
      // here would empty the cart right after promising the opposite.
      if (!landed && rejected.length) {
        // Every line was unavailable, so the account cart is still empty.
        // Saying the cart "was synced" here reads as the site losing the
        // cart; name the reason instead.
        notify.error(`${rejected.length} کالای سبد مهمان موجود نبود و به سبد شما اضافه نشد`);
      } else if (adjusted.length || rejected.length) {
        const affected = adjusted.length + rejected.length;
        notify.error(`موجودی ${affected} مورد از سبد تغییر کرده بود؛ سبد با موجودی فعلی هماهنگ شد`);
      } else {
        notify.success("سبد خرید مهمان به حساب شما منتقل شد");
      }
      await fetchUserCart();
    } catch (error) {
      console.error("Guest cart merge failed; local cart was preserved:", error);
      notify.error(
        "انتقال سبد مهمان کامل نشد؛ کالاهای شما حفظ شده‌اند و می‌توانید دوباره تلاش کنید",
      );
      await fetchUserCart();
    } finally {
      setIsLoading(false);
    }
  };

  const openDrawer = () => {
    setIsDrawerOpen(true);
  };

  const closeDrawer = () => {
    setIsDrawerOpen(false);
  };

  const addToCart = async (newItem: CartItem) => {
    // The shopper is editing the cart, so a banner about an earlier server-side
    // correction is stale; drop it rather than leaving it to be re-read.
    setStockNotice(null);
    if (isLoggedIn) {
      if (!isOnline()) {
        notify.error("برای تغییر سبد حساب کاربری، اتصال اینترنت را برقرار کنید");
        return;
      }

      // Optimistic update: add item to cart immediately
      const previousCartItems = cartItems;
      let itemWasAdded = false;

      setCartItems((prev) => {
        const existingItemIndex = prev.findIndex((item) => cartLineMatches(item, newItem));

        if (existingItemIndex !== -1) {
          // Update quantity if item exists
          const updatedItems = [...prev];
          const existingItem = updatedItems[existingItemIndex];
          updatedItems[existingItemIndex] = {
            ...existingItem,
            quantity: existingItem.quantity + newItem.quantity,
            price: newItem.price,
            originalPrice: newItem.originalPrice ?? existingItem.originalPrice,
            discountPercentage: newItem.discountPercentage ?? existingItem.discountPercentage,
            availableStock: newItem.availableStock ?? existingItem.availableStock,
          };
          itemWasAdded = true;
          return updatedItems;
        } else {
          // Add new item
          itemWasAdded = true;
          return [...prev, newItem];
        }
      });

      // Serialize the API mutation, but do not replay an ambiguous failure.
      try {
        setIsLoading(true);

        await cartRequestQueue.enqueue(
          async () => {
            await CartService.addItemToCart(Number(newItem.variationId), newItem.quantity);
            // Refresh cart to ensure consistency with backend
            await fetchUserCart();
            trackFunnelStep("add_to_cart", {
              valueToman: newItem.price * newItem.quantity,
              properties: {
                product_id: newItem.productId,
                ...(newItem.variationId ? { variant_id: newItem.variationId } : {}),
                quantity: newItem.quantity,
              },
            });
            hapticSuccess();
          },
          `add-${newItem.variationId || newItem.id}`,
        );
      } catch (error: any) {
        console.error("Failed to add item to cart:", error);

        // Revert optimistic update on failure
        setCartItems(previousCartItems);

        // Keep the cart synchronized when a snapshot lost a stock race.
        if (isCartStockLimitError(error)) {
          hapticError();
          await fetchUserCart();
          notify.error(CART_STOCK_LIMIT_MESSAGE);
        } else {
          hapticError();
          notify.error("افزودن کالا به سبد خرید با خطا مواجه شد");
        }
      } finally {
        setIsLoading(false);
      }
    } else {
      // Local storage implementation (no queue needed for guest users)
      setCartItems((prev) => {
        const existingItemIndex = prev.findIndex((item) => cartLineMatches(item, newItem));

        if (existingItemIndex !== -1) {
          const updatedItems = [...prev];
          const existingItem = updatedItems[existingItemIndex];
          updatedItems[existingItemIndex] = {
            ...existingItem,
            quantity: existingItem.quantity + newItem.quantity,
            price: newItem.price,
            originalPrice: newItem.originalPrice ?? existingItem.originalPrice,
            discountPercentage: newItem.discountPercentage ?? existingItem.discountPercentage,
            availableStock: newItem.availableStock ?? existingItem.availableStock,
          };
          return updatedItems;
        }

        return [...prev, newItem];
      });
      trackFunnelStep("add_to_cart", {
        valueToman: newItem.price * newItem.quantity,
        properties: {
          product_id: newItem.productId,
          ...(newItem.variationId ? { variant_id: newItem.variationId } : {}),
          quantity: newItem.quantity,
        },
      });
      hapticSuccess();
    }
  };

  const showRemoveUndoToast = (removedItem: CartItem) => {
    return toast.custom(
      (t) => (
        <div
          dir="rtl"
          className={`flex max-w-sm items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-right shadow-lg transition duration-200 ${
            t.visible ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
          }`}
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-neutral-800">کالا از سبد خرید حذف شد</p>
            <p className="mt-1 truncate text-xs text-neutral-500">{removedItem.name}</p>
          </div>
          <button
            type="button"
            className="shrink-0 rounded-lg bg-infinity-primary px-3 py-1.5 text-xs font-medium text-white transition hover:bg-infinity-primary/90"
            onClick={() => {
              toast.dismiss(t.id);
              void addToCart(removedItem);
            }}
          >
            برگرداندن
          </button>
        </div>
      ),
      { duration: 8000 },
    );
  };

  const removeFromCart = async (id: string) => {
    // The shopper is editing the cart, so a banner about an earlier server-side
    // correction is stale; drop it rather than leaving it to be re-read.
    setStockNotice(null);
    if (isLoggedIn) {
      // Optimistic update: remove item from cart immediately
      const previousCartItems = cartItems;

      // Find cart item ID from our local state that matches the item ID
      const item = cartItems.find((item) => item.id === id || item.cartItemId === id);
      if (!item) return;
      if (!isOnline()) {
        notify.error("برای تغییر سبد حساب کاربری، اتصال اینترنت را برقرار کنید");
        return;
      }

      const removalKey = item.cartItemId || item.id;
      if (!removalKey || pendingRemovals.current.has(removalKey)) return;
      pendingRemovals.current.add(removalKey);

      // Remove item optimistically
      setCartItems((prev) => prev.filter((item) => item.id !== id && item.cartItemId !== id));
      const undoToastId = showRemoveUndoToast(item);
      trackAnalyticsEvent({
        category: "ecommerce",
        action: "remove_from_cart",
        valueToman: item.price * item.quantity,
        properties: {
          product_id: item.productId,
          ...(item.variationId ? { variant_id: item.variationId } : {}),
          quantity: item.quantity,
        },
      });

      // Queue API call in the background
      try {
        setIsLoading(true);

        // Extract the cart item ID from the API (assuming it's in the variationId field)
        const cartItemId = item.cartItemId || item.id;
        if (!cartItemId) {
          throw new Error("Cart item ID not found");
        }

        await cartRequestQueue.enqueue(async () => {
          await CartService.removeCartItem(Number(cartItemId));
          await fetchUserCart();
        }, `remove-${cartItemId}`);
      } catch (error) {
        console.error("Failed to remove item from cart:", error);
        toast.dismiss(undoToastId);

        await fetchUserCart();
        notify.error("حذف کالا از سبد خرید با خطا مواجه شد");
      } finally {
        pendingRemovals.current.delete(removalKey ?? "");
        setIsLoading(false);
      }
    } else {
      // Local storage implementation (no queue needed for guest users)
      const existing = cartItems.find((item) => item.id === id);
      setCartItems((prev) => prev.filter((item) => item.id !== id));
      if (existing) {
        showRemoveUndoToast(existing);
        trackAnalyticsEvent({
          category: "ecommerce",
          action: "remove_from_cart",
          valueToman: existing.price * existing.quantity,
          properties: {
            product_id: existing.productId,
            ...(existing.variationId ? { variant_id: existing.variationId } : {}),
            quantity: existing.quantity,
          },
        });
      }
    }
  };

  const updateQuantity = async (id: string, quantity: number) => {
    // The shopper is editing the cart, so a banner about an earlier server-side
    // correction is stale; drop it rather than leaving it to be re-read.
    setStockNotice(null);
    if (quantity <= 0) {
      removeFromCart(id);
      return;
    }

    const item = cartItems.find((cartItem) => cartItem.id === id || cartItem.cartItemId === id);
    if (!item) return;
    // Only an increase can outrun stock. A line can already sit above its
    // available count (stock moved, or a reservation lowered it), and blocking
    // the decrease there would strand the shopper with a quantity they cannot
    // reduce — while lowering it strictly reduces the oversell.
    const isIncrease = quantity > item.quantity;
    if (isIncrease && typeof item.availableStock === "number" && quantity > item.availableStock) {
      notify.error(CART_STOCK_LIMIT_MESSAGE);
      return;
    }

    if (isLoggedIn) {
      // Optimistic update: update quantity immediately
      const previousCartItems = cartItems;

      // Find cart item ID from our local state that matches the item ID
      if (!isOnline()) {
        notify.error("برای تغییر سبد حساب کاربری، اتصال اینترنت را برقرار کنید");
        return;
      }

      // Update quantity optimistically
      setCartItems((prev) =>
        prev.map((cartItem) =>
          cartItem.id === id || cartItem.cartItemId === id ? { ...cartItem, quantity } : cartItem,
        ),
      );
      trackAnalyticsEvent({
        category: "ecommerce",
        action: "update_quantity",
        properties: {
          product_id: item.productId,
          ...(item.variationId ? { variant_id: item.variationId } : {}),
          quantity,
        },
      });

      // Queue API call in the background
      try {
        setIsLoading(true);

        // Extract the cart item ID from the API
        const cartItemId = item.cartItemId || item.id;
        if (!cartItemId) {
          throw new Error("Cart item ID not found");
        }

        await cartRequestQueue.enqueue(async () => {
          await CartService.updateCartItem(Number(cartItemId), quantity);
          // Refresh cart to ensure consistency with backend
          await fetchUserCart();
        }, `update-${cartItemId}`);
      } catch (error: any) {
        console.error("Failed to update cart item:", error);

        // Revert optimistic update on failure
        setCartItems(previousCartItems);

        // Keep the cart synchronized when a snapshot lost a stock race.
        if (isCartStockLimitError(error)) {
          await fetchUserCart();
          notify.error(CART_STOCK_LIMIT_MESSAGE);
        } else {
          notify.error("بروزرسانی سبد خرید با خطا مواجه شد");
        }
      } finally {
        setIsLoading(false);
      }
    } else {
      // Local storage implementation (no queue needed for guest users)
      setCartItems((prev) => prev.map((item) => (item.id === id ? { ...item, quantity } : item)));
      if (item) {
        trackAnalyticsEvent({
          category: "ecommerce",
          action: "update_quantity",
          properties: {
            product_id: item.productId,
            ...(item.variationId ? { variant_id: item.variationId } : {}),
            quantity,
          },
        });
      }
    }
  };

  const clearCart = async () => {
    if (isLoggedIn) {
      // Optimistically clear to avoid showing stale items if backend already emptied the cart
      setCartItems([]);
      try {
        await fetchUserCart();
      } catch (error) {
        console.error("[CartContext] Failed to refresh cart after clearing:", error);
      }
      return;
    }

    // For local storage users, clear the cart
    setCartItems([]);
    localStorage.removeItem("cart");
  };

  // Check if all items in cart have sufficient stock
  const checkCartStock = async (): Promise<boolean> => {
    if (isLoggedIn) {
      try {
        setIsLoading(true);

        const data = await CartService.checkCartStock();

        // If cart was modified (items adjusted or removed), refresh the local cart
        if (!data.valid) {
          applyStockCorrectionNotice(data);
          await fetchUserCart();
        }

        return data.valid;
      } catch (error) {
        console.error("Failed to check cart stock:", error);
        return false;
      } finally {
        setIsLoading(false);
      }
    } else {
      // For non-logged in users, we can't check stock, so assume it's valid
      // In a real app, you might want to implement a similar check for guest users
      return true;
    }
  };

  const totalItems = cartItems.reduce((sum, item) => sum + item.quantity, 0);

  const totalPrice = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0);

  const subtotalBeforeDiscount = cartItems.reduce((sum, item) => {
    const unit = item.originalPrice && item.originalPrice > 0 ? item.originalPrice : item.price;
    return sum + unit * item.quantity;
  }, 0);

  const cartDiscountTotal =
    subtotalBeforeDiscount > totalPrice ? subtotalBeforeDiscount - totalPrice : 0;

  const value = {
    cartItems,
    isDrawerOpen,
    openDrawer,
    closeDrawer,
    addToCart,
    removeFromCart,
    updateQuantity,
    clearCart,
    totalItems,
    totalPrice,
    subtotalBeforeDiscount,
    cartDiscountTotal,
    isLoading,
    isCartReady,
    checkCartStock,
    refreshCart: async () => {
      if (isLoggedIn) await fetchUserCart();
    },
    migrateLocalCartToApi,
    stockNotice,
    setStockNotice,
    dismissStockNotice: () => setStockNotice(null),
  };

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}
