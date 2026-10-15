"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseAsString, useQueryStates } from "nuqs";
import { useDebouncedCallback } from "use-debounce";
import type { AdminOrderDeliverySearch } from "@/services/super-admin/orders/list";

const parsers = {
  cityId: parseAsString.withDefault(""),
  provinceId: parseAsString.withDefault(""),
  productCode: parseAsString.withDefault(""),
  postalCode: parseAsString.withDefault(""),
  addressText: parseAsString.withDefault(""),
  page: parseAsString.withDefault("1"),
};
type Fields = {
  cityId: string;
  provinceId: string;
  productCode: string;
  postalCode: string;
  addressText: string;
};
const empty: Fields = {
  cityId: "",
  provinceId: "",
  productCode: "",
  postalCode: "",
  addressText: "",
};

export function useOrderDeliverySearch() {
  const [url, setUrl] = useQueryStates(parsers, { history: "push" });
  const applied = useMemo<Fields>(
    () => ({
      cityId: url.cityId,
      provinceId: url.provinceId,
      productCode: url.productCode,
      postalCode: url.postalCode,
      addressText: url.addressText,
    }),
    [
      url.cityId,
      url.provinceId,
      url.productCode,
      url.postalCode,
      url.addressText,
    ],
  );
  const [draftState, setDraftState] = useState({
    base: applied,
    values: applied,
  });
  const draftRef = useRef({ base: applied, values: applied });
  // Back/Forward uses the URL immediately; local drafts belong to the URL
  // state at which the operator began typing.
  const draft = draftState.base === applied ? draftState.values : applied;
  const apply = useDebouncedCallback((next: Fields) => {
    void setUrl({
      ...Object.fromEntries(
        Object.entries(next).map(([key, value]) => [key, value || null]),
      ),
      page: null,
    });
  }, 500);
  useEffect(() => {
    apply.cancel();
  }, [applied, apply]);
  useEffect(() => () => apply.cancel(), [apply]);
  const change = useCallback(
    (key: keyof Fields, value: string) => {
      const current =
        draftRef.current.base === applied ? draftRef.current.values : applied;
      const next = {
        ...current,
        [key]: value,
        ...(key === "provinceId" ? { cityId: "" } : {}),
      };
      draftRef.current = { base: applied, values: next };
      setDraftState(draftRef.current);
      apply(next);
    },
    [applied, apply],
  );
  const clear = useCallback(() => {
    apply.cancel();
    draftRef.current = { base: applied, values: empty };
    setDraftState(draftRef.current);
    void setUrl({
      cityId: null,
      provinceId: null,
      productCode: null,
      postalCode: null,
      addressText: null,
      page: null,
    });
  }, [applied, apply, setUrl]);
  const searchFilters = useMemo<AdminOrderDeliverySearch>(
    () => ({
      cityId: applied.cityId || undefined,
      productCode: applied.productCode || undefined,
      postalCode: applied.postalCode || undefined,
      addressText: applied.addressText || undefined,
    }),
    [applied],
  );
  return {
    draft,
    change,
    clear,
    searchFilters,
    active: Object.values(searchFilters).some(Boolean),
  };
}
