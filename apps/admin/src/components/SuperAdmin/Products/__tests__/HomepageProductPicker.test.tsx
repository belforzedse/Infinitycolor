/**
 * The picker used to claim all 26 selected products were live. The backend slices
 * several manual sections to HOMEPAGE_CARD_LIMIT (20), so overflow in those
 * sections needs a warning. Newest uses a separate 100-product rail.
 */
import { fireEvent, render, screen } from "@testing-library/react";
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
    expect(screen.getAllByText("فقط در «مشاهده همه»")).toHaveLength(6);
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

describe("HomepageProductPicker eligibility badges", () => {
  it("flags an inactive/unpublished curated pick without hiding it", () => {
    render(
      <HomepageProductPicker
        title="جدیدترین ها"
        selectedProductIds={[1, 2]}
        productSummaries={[
          { id: 1, title: "product-1", isEligible: true },
          { id: 2, title: "product-2", isEligible: false },
        ]}
        onProductsChange={() => {}}
      />,
    );

    expect(screen.getByText("غیرفعال / منتشرنشده")).toBeInTheDocument();
    expect(screen.getAllByTestId("picker-row")).toHaveLength(2);
  });

  it("flags a curated pick that lost its discount only for the discount section", () => {
    render(
      <HomepageProductPicker
        title="تخفیف‌های وسوسه انگیز"
        selectedProductIds={[1]}
        productSummaries={[{ id: 1, title: "product-1", isEligible: true, isDiscounted: false }]}
        onProductsChange={() => {}}
        sectionKind="discount"
      />,
    );

    expect(screen.getByText("بدون تخفیف")).toBeInTheDocument();
  });

  it("does not flag a missing discount for a non-discount section", () => {
    render(
      <HomepageProductPicker
        title="جدیدترین ها"
        selectedProductIds={[1]}
        productSummaries={[{ id: 1, title: "product-1", isEligible: true, isDiscounted: false }]}
        onProductsChange={() => {}}
        sectionKind="newest"
      />,
    );

    expect(screen.queryByText("بدون تخفیف")).not.toBeInTheDocument();
  });
});

describe("HomepageProductPicker reordering", () => {
  it("moves an item to the top or bottom in one step", () => {
    const ids = [1, 2, 3, 4];
    const onProductsChange = jest.fn();
    render(
      <HomepageProductPicker
        title="جدیدترین ها"
        selectedProductIds={ids}
        productSummaries={summaries(ids)}
        onProductsChange={onProductsChange}
      />,
    );

    fireEvent.click(screen.getAllByLabelText("انتقال به بالاترین جایگاه")[2]);
    expect(onProductsChange).toHaveBeenLastCalledWith([3, 1, 2, 4]);

    fireEvent.click(screen.getAllByLabelText("انتقال به پایین‌ترین جایگاه")[0]);
    expect(onProductsChange).toHaveBeenLastCalledWith([2, 3, 4, 1]);
  });
});
