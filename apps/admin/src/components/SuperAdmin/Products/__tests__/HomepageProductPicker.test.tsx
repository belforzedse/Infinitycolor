/**
 * The picker used to claim all 26 selected products were live. The backend slices
 * every manual section to HOMEPAGE_CARD_LIMIT (20), so six of them were saved and
 * never rendered, with nothing in the UI saying so.
 */
import { render, screen } from "@testing-library/react";
import HomepageProductPicker from "../HomepageProductPicker";

jest.mock("@/components/SuperAdmin/Order/ProductSearch", () => ({
  __esModule: true,
  default: () => <div data-testid="product-search" />,
}));

jest.mock("next/image", () => ({
  __esModule: true,
  // eslint-disable-next-line @next/next/no-img-element -- a stub for next/image in jsdom
  default: (props: Record<string, unknown>) => <img alt="" {...props} />,
}));

const summaries = (ids: number[]) => ids.map((id) => ({ id, title: `product-${id}` }));

function renderPicker(count: number, renderLimit?: number) {
  const ids = Array.from({ length: count }, (_, i) => i + 1);
  render(
    <HomepageProductPicker
      title="جدیدترین ها"
      selectedProductIds={ids}
      productSummaries={summaries(ids)}
      onProductsChange={() => {}}
      renderLimit={renderLimit}
    />,
  );
}

describe("HomepageProductPicker render limit", () => {
  it("marks every position past the limit as not rendered", () => {
    renderPicker(26, 20);

    expect(screen.getAllByTestId("picker-row-not-rendered")).toHaveLength(6);
    expect(screen.getAllByTestId("picker-row")).toHaveLength(20);
    expect(screen.getAllByText("نمایش داده نمی‌شود")).toHaveLength(6);
  });

  it("marks nothing when the list fits inside the limit", () => {
    renderPicker(20, 20);

    expect(screen.queryAllByTestId("picker-row-not-rendered")).toHaveLength(0);
    expect(screen.getAllByTestId("picker-row")).toHaveLength(20);
  });

  it("marks nothing when no limit is given", () => {
    renderPicker(26);

    expect(screen.queryAllByTestId("picker-row-not-rendered")).toHaveLength(0);
  });

  it("keeps the search box available even when over the limit", () => {
    // A hard `maxProducts` cap would replace the search with a warning, leaving an
    // over-limit section impossible to edit. The limit is advisory on purpose.
    renderPicker(26, 20);

    expect(screen.getByTestId("product-search")).toBeInTheDocument();
  });
});
