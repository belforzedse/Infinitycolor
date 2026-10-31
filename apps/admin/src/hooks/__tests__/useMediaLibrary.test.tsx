import { act, renderHook, waitFor } from "@testing-library/react";
import { useMediaLibrary } from "../useMediaLibrary";
import { listMediaLibrary, type MediaLibraryItem } from "@/services/super-admin/files/mediaLibrary";

jest.mock("@/services/super-admin/files/mediaLibrary", () => ({ listMediaLibrary: jest.fn() }));

it("keeps a newly uploaded image when an older library request finishes", async () => {
  let resolve!: (value: unknown) => void;
  (listMediaLibrary as jest.Mock).mockReturnValue(new Promise((done) => { resolve = done; }));
  const { result } = renderHook(() => useMediaLibrary({ initialType: "image" }));
  const uploaded = { id: 9, mime: "image/jpeg" } as MediaLibraryItem;
  act(() => result.current.prepend(uploaded));
  await act(async () => resolve({ data: [{ id: 1, mime: "image/jpeg" }], meta: { pagination: { total: 1 } } }));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  expect(result.current.items.map((item) => item.id)).toEqual([9, 1]);
  expect(result.current.total).toBe(2);
});
