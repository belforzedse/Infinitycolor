"use client";

import * as Sentry from "@sentry/nextjs";
import { diagnosticAttributes } from "@/lib/diagnostic-log";
import { useState, useEffect, useRef } from "react";
import { apiClient } from "@/services";
import { ENDPOINTS } from "@/constants/api";
import { atom, useAtom } from "jotai";
import { centralAuth, centralLoginUrl, readAuthStateVersion } from "@/lib/central-auth";
import { logDiagnostic } from "@/lib/diagnostic-log";
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
const pendingLikes = new Set<string>();
const likeRevisions = new Map<number, number>();

const likedProductsRequests = new Map<string, Promise<LikedProduct[] | null>>();
const retryAfter = new Map<string, number>();

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

function reportFailure(error: unknown, operation: "wishlist_load" | "wishlist_toggle"): void {
  const fields = error as
    | { name?: string; diagnostics?: Record<string, unknown>; cause?: Error }
    | undefined;
  logDiagnostic("auth.recovery", { operation, outcome: "unavailable" });
  if (fields?.name === "TokenAcquisitionError") return;
  try {
    const safe = new Error("Wishlist request failed");
    // Shared transport causes are already sanitized. Never attach a response body or URL.
    if (fields?.diagnostics && fields.cause instanceof Error) safe.cause = fields.cause;
    Sentry.captureException(safe, {
      tags: { operation },
      extra: diagnosticAttributes({
        failure_stage: fields?.diagnostics?.stage,
        cause_type: fields?.diagnostics?.name,
        cause_code: fields?.diagnostics?.code,
        http_status: fields?.diagnostics?.httpStatus,
        request_id: fields?.diagnostics?.requestId,
      }),
      fingerprint: ["wishlist", operation],
    });
  } catch {
    /* Telemetry cannot affect wishlist state. */
  }
}

const fetchLikesForUser = (userId: number): Promise<LikedProduct[] | null> => {
  const key = `${userId}:${readAuthStateVersion()}`;
  const existing = likedProductsRequests.get(key);
  if (existing) return existing;
  if (Date.now() < (retryAfter.get(key) ?? 0)) return Promise.resolve(null);

  const request = (async () => {
    const outcome = await centralAuth.tokenManager.getTokenOutcome();
    if (outcome.state !== "authenticated") {
      retryAfter.set(key, Date.now() + 30_000);
      logDiagnostic("auth.recovery", { operation: "wishlist_load", outcome: outcome.state });
      return null;
    }
    const response = await apiClient.get<{ data: LikedProduct[] }>(
      ENDPOINTS.PRODUCT_LIKES.USER_LIKES,
    );
    return Array.isArray(response.data) ? response.data : [];
  })()
    .catch((error: unknown) => {
      retryAfter.set(key, Date.now() + 30_000);
      if (key === `${userId}:${readAuthStateVersion()}`) reportFailure(error, "wishlist_load");
      return null;
    })
    .finally(() => {
      if (likedProductsRequests.get(key) === request) likedProductsRequests.delete(key);
    });

  while (retryAfter.size > 16) retryAfter.delete(retryAfter.keys().next().value!);
  likedProductsRequests.set(key, request);
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
  const identity = useRef({ userId, generation: 0 });
  if (identity.current.userId !== userId) {
    identity.current = { userId, generation: identity.current.generation + 1 };
  }

  // Ensure likedProducts is always an array
  const safeProducts = likesOwner === userId && Array.isArray(likedProducts) ? likedProducts : [];

  useEffect(() => {
    setIsMounted(true);
    return () => {
      identity.current.generation += 1;
    };
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

    const authVersion = readAuthStateVersion();
    let lastAttempt = -Infinity;
    const current = () => active && authVersion === readAuthStateVersion();
    const load = async () => {
      if (!current() || Date.now() - lastAttempt < 30_000) return;
      lastAttempt = Date.now();
      try {
        setIsGlobalLoading(true);
        const revision = likeRevisions.get(userId) || 0;
        const products = await fetchLikesForUser(userId);
        if (!current() || products === null || revision !== (likeRevisions.get(userId) || 0))
          return;
        setLikedProducts(products);
        setLikesOwner(userId);
        setHasLoaded(true);
      } catch (error) {
        console.error("Wishlist load unavailable");
        // Preserve this identity's existing wishlist during temporary unavailability.
        logDiagnostic("auth.recovery", { operation: "wishlist_load", outcome: "unavailable" });
      } finally {
        if (active) setIsGlobalLoading(false);
      }
    };

    void load();
    const retry = () => {
      void load();
    };
    window.addEventListener("focus", retry);
    window.addEventListener("online", retry);
    return () => {
      active = false;
      window.removeEventListener("focus", retry);
      window.removeEventListener("online", retry);
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

  // Toggle like status. Resolves to the server-confirmed favorite state, or null
  // when nothing changed (signed out, already pending, superseded, or failed).
  const toggleLike = async (e: React.MouseEvent<HTMLButtonElement>): Promise<boolean | null> => {
    e.preventDefault();
    e.stopPropagation();

    const key = `${userId}:${productId}`;
    if (pendingLikes.has(key)) return null;
    pendingLikes.add(key);
    setIsLoading(true);
    const generation = identity.current.generation;
    const authVersion = readAuthStateVersion();
    const current = () =>
      identity.current.generation === generation && authVersion === readAuthStateVersion();
    const desired = !safeProducts.some(({ product }) => String(product?.id) === String(productId));
    try {
      const outcome = await centralAuth.tokenManager.getTokenOutcome();
      if (!current()) return null;
      if (outcome.state === "unauthenticated") {
        redirectToAuth();
        return null;
      }
      if (outcome.state !== "authenticated") {
        logDiagnostic("auth.recovery", { operation: "wishlist_toggle", outcome: outcome.state });
        return null;
      }
      if (userId !== null) likeRevisions.set(userId, (likeRevisions.get(userId) || 0) + 1);
      const response = await apiClient.post<{ isFavorite: boolean }>(
        ENDPOINTS.PRODUCT_LIKES.TOGGLE,
        { productId, isFavorite: desired },
      );
      if (!current()) return null;
      const result = response as unknown as { isFavorite?: boolean };
      if (typeof result.isFavorite !== "boolean") throw new Error("Invalid favorite response");
      setLikedProducts((current) => {
        const others = current.filter(({ product }) => String(product?.id) !== String(productId));
        return result.isFavorite
          ? [
              ...others,
              {
                id: Number(productId),
                product: { id: Number(productId) },
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ]
          : others;
      });
      return result.isFavorite;
    } catch (error) {
      if (current()) reportFailure(error, "wishlist_toggle");
      return null;
    } finally {
      pendingLikes.delete(key);
      if (current()) setIsLoading(false);
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

export const __resetUseProductLikeState = () => {
  likedProductsRequests.clear();
  retryAfter.clear();
  pendingLikes.clear();
  likeRevisions.clear();
};
