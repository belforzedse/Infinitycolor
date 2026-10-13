"use client";

import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
} from "react";
import { apiClient } from "@/services";
import type {
  ProductEditorSession,
  ProductEditorState,
} from "@/services/super-admin/product/editor-session";

export const ProductEditorContext = createContext<ProductEditorSession | null>(
  null,
);
const standaloneState: ProductEditorState = {
  phase: "editing",
  status: null,
  busy: false,
  snapshotEpoch: 0,
};
const noSubscribe = () => () => undefined;
const getStandalone = () => standaloneState;

export function useProductEditor() {
  const session = useContext(ProductEditorContext);
  const state = useSyncExternalStore(
    session?.subscribe ?? noSubscribe,
    session?.getState ?? getStandalone,
    session?.getState ?? getStandalone,
  );
  return {
    session,
    state,
    canEdit: state.phase === "editing",
    client: session?.client ?? apiClient,
  };
}

/** Retains tab drafts within this mounted editor, including on ownership loss. */
export function useProductEditorDraft(key: string, value: unknown) {
  const { session } = useProductEditor();
  useEffect(() => {
    session?.drafts.set(key, value);
  }, [session, key, value]);
  return session?.drafts.get(key);
}
