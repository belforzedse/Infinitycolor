/** Per-product homepage writes send boolean membership deltas; the server owns arrays and ordering. */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { apiClient } from "@/services";
jest.mock("@/services", () => ({ apiClient: { put: jest.fn() } }));
import ProductHomepageSectionsCard from "../ProductHomepageSectionsCard";
import {
  getHomepageProductSettings,
} from "@/services/super-admin/settings/homepageProducts";
import { getProductSummariesByIds } from "@/services/super-admin/product/get";
import { defaultSettings } from "@/types/super-admin/settings";

jest.mock("@/services/super-admin/settings/homepageProducts", () => ({
  getHomepageProductSettings: jest.fn(),
}));

jest.mock("@/services/super-admin/product/get", () => ({
  getProductSummariesByIds: jest.fn(),
}));

jest.mock("react-hot-toast", () => {
  const toast = Object.assign(jest.fn(), { success: jest.fn(), error: jest.fn() });
  return { __esModule: true, default: toast, toast };
});

const mockedGet = getHomepageProductSettings as jest.MockedFunction<
  typeof getHomepageProductSettings
>;
const mockedUpdate = apiClient.put as jest.Mock;
const mockedSummaries = getProductSummariesByIds as jest.MockedFunction<
  typeof getProductSummariesByIds
>;

const settingsWith = (overrides: {
  newest?: number[];
  favorite?: number[];
  discounted?: number[];
}) => ({
  ...defaultSettings(),
  homeNewestProductIds: overrides.newest ?? [],
  homeFavoriteProductIds: overrides.favorite ?? [],
  homeDiscountedProductIds: overrides.discounted ?? [],
});

const NEWEST = "homepage-section-homeNewestProductIds";
const FAVORITE = "homepage-section-homeFavoriteProductIds";

beforeEach(() => {
  jest.clearAllMocks();
  mockedSummaries.mockResolvedValue([{ id: 7, title: "محصول", isEligible: true }]);
  mockedUpdate.mockResolvedValue({ data: { id: 1, attributes: settingsWith({}) }, meta: { editRevision: 2 } });
});

async function renderCard(settings: ReturnType<typeof settingsWith>) {
  mockedGet.mockResolvedValue(settings);
  render(<ProductHomepageSectionsCard productId={7} />);
  await screen.findByTestId(NEWEST);
}

describe("ProductHomepageSectionsCard", () => {
  it("sends only the product membership change for backend ordering", async () => {
    await renderCard(settingsWith({ newest: [11, 12, 13] }));

    fireEvent.click(screen.getByTestId(NEWEST));
    fireEvent.click(screen.getByTestId("homepage-sections-save"));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalled());
    expect(mockedUpdate).toHaveBeenCalledWith("/products/7/editor/homepage", { data: { homeNewestProductIds: true } }, { retries: 0 });
  });

  it("omits sections the operator did not touch", async () => {
    await renderCard(settingsWith({ newest: [], favorite: [4, 5], discounted: [6] }));

    fireEvent.click(screen.getByTestId(NEWEST));
    fireEvent.click(screen.getByTestId("homepage-sections-save"));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalled());
    const payload = mockedUpdate.mock.calls[0][1].data;
    expect(Object.keys(payload)).toEqual(["homeNewestProductIds"]);
    expect(payload.homeFavoriteProductIds).toBeUndefined();
    expect(payload.homeDiscountedProductIds).toBeUndefined();
  });

  it("removes the product without disturbing the rest of the order", async () => {
    await renderCard(settingsWith({ favorite: [11, 7, 12] }));

    fireEvent.click(screen.getByTestId(FAVORITE));
    fireEvent.click(screen.getByTestId("homepage-sections-save"));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalled());
    expect(mockedUpdate).toHaveBeenCalledWith("/products/7/editor/homepage", { data: { homeFavoriteProductIds: false } }, { retries: 0 });
  });

  it("never resends arrays from a stale page or a concurrent reorder", async () => {
    await renderCard(settingsWith({ newest: [11, 12] }));

    // Another admin reorders and adds a product while this page sits open.
    mockedGet.mockResolvedValue(settingsWith({ newest: [12, 99, 11] }));

    fireEvent.click(screen.getByTestId(NEWEST));
    fireEvent.click(screen.getByTestId("homepage-sections-save"));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalled());
    expect(mockedUpdate.mock.calls[0][1]).toEqual({ data: { homeNewestProductIds: true } });
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when the checkboxes have not changed", async () => {
    await renderCard(settingsWith({ newest: [7, 11] }));
    fireEvent.click(screen.getByTestId("homepage-sections-save"));
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("warns that the first pick takes the section off automatic", async () => {
    await renderCard(settingsWith({ newest: [] }));

    fireEvent.click(screen.getByTestId(NEWEST));

    expect(screen.getByText(/این بخش اکنون خودکار پر می‌شود/)).toBeInTheDocument();
  });

  it("warns that removing the last pick puts the section back on automatic", async () => {
    await renderCard(settingsWith({ newest: [7] }));

    fireEvent.click(screen.getByTestId(NEWEST));

    expect(screen.getByText(/بخش دوباره خودکار می‌شود/)).toBeInTheDocument();
  });

  it("keeps save disabled until something actually changes", async () => {
    await renderCard(settingsWith({ newest: [7] }));

    expect(screen.getByTestId("homepage-sections-save")).toBeDisabled();
    fireEvent.click(screen.getByTestId(NEWEST));
    expect(screen.getByTestId("homepage-sections-save")).toBeEnabled();
  });

  it("flags a curated position the homepage carousel will not render", async () => {
    await renderCard(settingsWith({ newest: [...Array.from({ length: 24 }, (_, i) => i + 100), 7] }));

    expect(screen.getByText(/جایگاه ۲۵ از ۲۵/)).toBeInTheDocument();
    expect(screen.getByText(/فقط در «مشاهده همه» دیده می‌شود/)).toBeInTheDocument();
  });
});
