import { atom } from "jotai";

// Keep searches only in the current browser app session, never in the URL or storage.
export const orderListSearchAtom = atom("");
