"use client";

import { useState, useEffect } from "react";
import { apiClient } from "@/services";
import { ENDPOINTS } from "@/constants/api";
import { atom, useAtom } from "jotai";
import { centralAuth, centralLoginUrl } from "@/lib/central-auth";
import { useCurrentUser } from "@/hooks/useCurrentUser";

// Global atom to store liked products
type LikedProduct = {
  createdAt: string;
  id: number;
  product: {
    id: number;
  };
  updatedAt: string;
};

export const likedProductsAtom = atom<LikedProduct[]>([]);
const likedProductsLoadingAtom = atom<boolean>(false);
export const likedProductsLoadedAtom = atom<boolean>(false);

/**
 * Which identity the cached likes belong to. Likes are private state, so they are only
 * meaningful relative to the user they were fetched for: without this, A's wishlist stayed
 * in the atom after A logged out and was shown to B on the next login.
 */
export const likedProductsOwnerAtom = atom<number | null>(null);

/**
 * In-flight requests keyed by identity, so sibling cards mounted in the same render share
 * one fetch. Entries are deleted when they settle.
 *
 * This replaces a module-level `let fetchStarted = false`, which was set before the auth
 * check ran: an anonymous first mount flipped it to true permanently, and the fetch that
 * should have followed login never happened. A keyed, self-evicting map cannot develop
 * that failure mode — a new identity is a new key, and a failed fetch leaves no entry.
 */
const likedProductsRequests = new Map<number, Promise<LikedProduct[]>>();

interface UseProductLikeParams {
  productId: string;
}

export function setWindowLocation(url: string) {
  window.location.href = url;
}

export const navigationUtils = {
  setWindowLocation,
};

export const redirectToAuth = () => {
  navigationUtils.setWindowLocation(centralLoginUrl(window.location.pathname));
};

const fetchLikesForUser = (userId: number): Promise<LikedProduct[]> => {
  const existing = likedProductsRequests.get(userId);
  if (existing) return existing;

  const request = apiClient
    .get<{ data: LikedProduct[] }>(ENDPOINTS.PRODUCT_LIKES.USER_LIKES)
    .then((response) => (Array.isArray(response.data) ? response.data : []))
    .finally(() => {
      likedProductsRequests.delete(userId);
    });

  likedProductsRequests.set(userId, request);
  return request;
};

const useProductLike = ({ productId }: UseProductLikeParams) => {
  const [isMounted, setIsMounted] = useState(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [likedProducts, setLikedProducts] = useAtom(likedProductsAtom);
  const [isGlobalLoading, setIsGlobalLoading] = useAtom(likedProductsLoadingAtom);
  const [hasLoaded, setHasLoaded] = useAtom(likedProductsLoadedAtom);
  const [likesOwner, setLikesOwner] = useAtom(likedProductsOwnerAtom);
  const { user } = useCurrentUser();
  const userId = typeof user?.id === "number" ? user.id : null;

  // Ensure likedProducts is always an array
  const safeProducts = Array.isArray(likedProducts) ? likedProducts : [];

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    let active = true;

    // Signing out, or switching accounts, invalidates the cached wishlist immediately —
    // before any request for the new identity resolves — so B never sees A's state.
    if (userId === null) {
      if (likesOwner !== null) {
        setLikedProducts([]);
        setHasLoaded(false);
        setLikesOwner(null);
      }
      return;
    }

    if (likesOwner === userId && hasLoaded) return;

    const load = async () => {
      const token = await centralAuth.tokenManager.getToken();
      if (!active || !token) return;

      try {
        setIsGlobalLoading(true);
        const products = await fetchLikesForUser(userId);
        if (!active) return;
        setLikedProducts(products);
        setLikesOwner(userId);
        setHasLoaded(true);
      } catch (error) {
        console.error("Error fetching liked products:", error);
        // Deliberately leaves hasLoaded false so a later render can retry; the map entry
        // has already been evicted by then.
        if (!active) return;
        setLikedProducts([]);
      } finally {
        if (active) setIsGlobalLoading(false);
      }
    };

    load();

    return () => {
      active = false;
    };
  }, [
    userId,
    likesOwner,
    hasLoaded,
    setLikedProducts,
    setIsGlobalLoading,
    setHasLoaded,
    setLikesOwner,
  ]);

  // Toggle like status
  const toggleLike = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();

    const token = await centralAuth.tokenManager.getToken();
    if (!token) {
      // Redirect to login page if no token
      redirectToAuth();
      return;
    }

    try {
      setIsLoading(true);
      await apiClient.post(ENDPOINTS.PRODUCT_LIKES.TOGGLE, { productId });

      // Update the global state
      if (safeProducts.some(({ product }) => product?.id?.toString() === String(productId))) {
        setLikedProducts(
          safeProducts.filter(({ product }) => product?.id?.toString() !== String(productId)),
        );
      } else {
        setLikedProducts([
          ...safeProducts,
          {
            id: Number(productId),
            createdAt: new Date().toISOString(),
            product: { id: Number(productId) },
            updatedAt: new Date().toISOString(),
          },
        ]);
      }
    } catch (error) {
      console.error("Error toggling product like:", error);
    } finally {
      setIsLoading(false);
    }
  };

  return {
    isLiked:
      isMounted && productId && productId !== ""
        ? safeProducts.some(({ product }) => product?.id?.toString() === productId.toString())
        : false,
    isLoading: isMounted && (isLoading || isGlobalLoading),
    toggleLike,
  };
};

export default useProductLike;
