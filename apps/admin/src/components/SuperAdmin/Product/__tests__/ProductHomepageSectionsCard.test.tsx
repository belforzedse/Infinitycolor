/**
 * The card owns ONE product's membership in the curated homepage rails while
 * /products/homepage owns the whole list. Its correctness rests on three properties:
 * a check prepends (position 1, never buried past the 20-item carousel slice), an
 * untouched section never appears in the payload, and the payload is computed from a
 * save-time read rather than the mount-time snapshot — otherwise saving here silently
 * reverts whatever another admin reordered while the product page sat open.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ProductHomepageSectionsCard from "../ProductHomepageSectionsCard";
import {
  getHomepageProductSettings,
  updateHomepageProductSettings,
} from "@/services/super-admin/settings/homepageProducts";
import { getProductSummariesByIds } from "@/services/super-admin/product/get";
import { defaultSettings } from "@/types/super-admin/settings";

jest.mock("@/services/super-admin/settings/homepageProducts", () => ({
  getHomepageProductSettings: jest.fn(),
  updateHomepageProductSettings: jest.fn(),
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
const mockedUpdate = updateHomepageProductSettings as jest.MockedFunction<
  typeof updateHomepageProductSettings
>;
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
  mockedUpdate.mockImplementation(async (payload) =>
    ({ ...settingsWith({}), ...payload }) as Awaited<ReturnType<typeof updateHomepageProductSettings>>,
  );
});

async function renderCard(settings: ReturnType<typeof settingsWith>) {
  mockedGet.mockResolvedValue(settings);
  render(<ProductHomepageSectionsCard productId={7} />);
  await screen.findByTestId(NEWEST);
}

describe("ProductHomepageSectionsCard", () => {
  it("prepends the product and pushes the existing list down", async () => {
    await renderCard(settingsWith({ newest: [11, 12, 13] }));

    fireEvent.click(screen.getByTestId(NEWEST));
    fireEvent.click(screen.getByTestId("homepage-sections-save"));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalled());
    expect(mockedUpdate).toHaveBeenCalledWith({ homeNewestProductIds: [7, 11, 12, 13] });
  });

  it("omits sections the operator did not touch", async () => {
    await renderCard(settingsWith({ newest: [], favorite: [4, 5], discounted: [6] }));

    fireEvent.click(screen.getByTestId(NEWEST));
    fireEvent.click(screen.getByTestId("homepage-sections-save"));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalled());
    const payload = mockedUpdate.mock.calls[0][0];
    expect(Object.keys(payload)).toEqual(["homeNewestProductIds"]);
    expect(payload.homeFavoriteProductIds).toBeUndefined();
    expect(payload.homeDiscountedProductIds).toBeUndefined();
  });

  it("removes the product without disturbing the rest of the order", async () => {
    await renderCard(settingsWith({ favorite: [11, 7, 12] }));

    fireEvent.click(screen.getByTestId(FAVORITE));
    fireEvent.click(screen.getByTestId("homepage-sections-save"));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalled());
    expect(mockedUpdate).toHaveBeenCalledWith({ homeFavoriteProductIds: [11, 12] });
  });

  it("builds the payload from a save-time read, keeping a concurrent reorder", async () => {
    await renderCard(settingsWith({ newest: [11, 12] }));

    // Another admin reorders and adds a product while this page sits open.
    mockedGet.mockResolvedValue(settingsWith({ newest: [12, 99, 11] }));

    fireEvent.click(screen.getByTestId(NEWEST));
    fireEvent.click(screen.getByTestId("homepage-sections-save"));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalled());
    expect(mockedUpdate).toHaveBeenCalledWith({ homeNewestProductIds: [7, 12, 99, 11] });
  });

  it("writes nothing when the save-time read already matches the checkboxes", async () => {
    await renderCard(settingsWith({ newest: [11] }));

    // Someone else added this product in the meantime — our delta is already applied.
    mockedGet.mockResolvedValue(settingsWith({ newest: [7, 11] }));

    fireEvent.click(screen.getByTestId(NEWEST));
    fireEvent.click(screen.getByTestId("homepage-sections-save"));

    await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(2));
    expect(mockedUpdate).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId(NEWEST)).toBeChecked());
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
