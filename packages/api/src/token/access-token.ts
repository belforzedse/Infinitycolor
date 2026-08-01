"use client";

/** Legacy names retained only so old imports fail closed during migration. */

export const ACCESS_TOKEN_STORAGE_KEY = "accessToken";
export const ACCESS_TOKEN_EVENT = "auth-access-token-changed";

const dispatchAccessTokenChange = () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(ACCESS_TOKEN_EVENT));
};

export const setAccessToken = (_token: string): never => {
  throw new Error("Reusable auth tokens may not be stored in the browser");
};

export const clearAccessToken = () => {
  dispatchAccessTokenChange();
};
