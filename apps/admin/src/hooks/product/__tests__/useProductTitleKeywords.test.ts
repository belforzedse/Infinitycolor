import { act, renderHook, waitFor } from "@testing-library/react";
import { useProductTitleKeywords } from "../useProductTitleKeywords";
import { getProductTitleKeywords } from "@/services/super-admin/product/title-keywords";
import { notifyProductTitleKeywordsChanged } from "@/services/super-admin/product/title-keywords-events";

jest.mock("@/services/super-admin/product/title-keywords", () => ({
  getProductTitleKeywords: jest.fn(),
}));

const mockedGetKeywords = jest.mocked(getProductTitleKeywords);

describe("useProductTitleKeywords", () => {
  beforeEach(() => {
    mockedGetKeywords.mockReset();
  });

  it("loads keywords once and keeps them across rerenders", async () => {
    mockedGetKeywords.mockResolvedValue(["شومیز", "نخی"]);

    const { result, rerender } = renderHook(() => useProductTitleKeywords());

    await waitFor(() => {
      expect(result.current).toEqual(["شومیز", "نخی"]);
    });

    expect(mockedGetKeywords).toHaveBeenCalledTimes(1);

    rerender();
    rerender();

    expect(result.current).toEqual(["شومیز", "نخی"]);
    expect(mockedGetKeywords).toHaveBeenCalledTimes(1);
  });
  it("reloads keywords after a save notification and window focus", async () => {
    mockedGetKeywords
      .mockResolvedValueOnce(["شومیز"])
      .mockResolvedValueOnce(["شومیز", "کتان"])
      .mockResolvedValueOnce(["شومیز", "کتان", "لینن"]);

    const { result, rerender } = renderHook(() => useProductTitleKeywords());

    await waitFor(() => {
      expect(result.current).toEqual(["شومیز"]);
    });

    act(() => {
      notifyProductTitleKeywordsChanged();
    });

    await waitFor(() => {
      expect(result.current).toEqual(["شومیز", "کتان"]);
    });

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      expect(result.current).toEqual(["شومیز", "کتان", "لینن"]);
    });

    expect(mockedGetKeywords).toHaveBeenCalledTimes(3);

    rerender();

    expect(mockedGetKeywords).toHaveBeenCalledTimes(3);
  });

  it("removes event listeners when the form unmounts", async () => {
    mockedGetKeywords.mockResolvedValue(["شومیز"]);

    const { result, unmount } = renderHook(() => useProductTitleKeywords());

    await waitFor(() => {
      expect(result.current).toEqual(["شومیز"]);
    });

    unmount();

    act(() => {
      notifyProductTitleKeywordsChanged();
      window.dispatchEvent(new Event("focus"));
    });

    expect(mockedGetKeywords).toHaveBeenCalledTimes(1);
  });
});
