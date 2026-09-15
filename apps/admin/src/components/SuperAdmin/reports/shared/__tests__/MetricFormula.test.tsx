import { render, screen } from "@testing-library/react";
import MetricFormula from "../MetricFormula";

/**
 * The component exists because two correct money figures on two pages read as a
 * contradiction without the term between them. So the things worth pinning are:
 * the arithmetic is visible, a zero term is still drawn (an invisible ۰ is what
 * makes the subtraction look wrong), and an approximate relation never renders
 * as "=".
 */
describe("MetricFormula", () => {
  it("draws every term with its operator, including zero terms", () => {
    const { container } = render(
      <MetricFormula
        terms={[
          { label: "فروش ناخالص", value: 78_897_000 },
          { label: "تخفیف‌ها", value: 0, op: "−" },
          { label: "مرجوعی‌ها", value: 0, op: "−" },
        ]}
        result={{ label: "فروش خالص", value: 78_897_000 }}
      />,
    );

    // A term that reads ۰ is the whole point: it shows the gap is not a discount.
    expect(screen.getByText("تخفیف‌ها")).toBeInTheDocument();
    expect(screen.getByText("مرجوعی‌ها")).toBeInTheDocument();
    expect(screen.getAllByText("۰ تومان")).toHaveLength(2);
    expect(screen.getAllByText("۷۸٬۸۹۷٬۰۰۰ تومان")).toHaveLength(2);

    expect(container.textContent).toContain("−تخفیف‌ها");
    expect(container.textContent).toContain("=فروش خالص");
  });

  it("defaults a term with no operator to +", () => {
    const { container } = render(
      <MetricFormula
        terms={[
          { label: "فروش کالا", value: 78_897_000 },
          { label: "هزینه ارسال", value: 3_170_000 },
        ]}
        result={{ label: "دریافتی درگاه‌ها", value: 82_067_000 }}
      />,
    );
    expect(container.textContent).toContain("+هزینه ارسال");
  });

  it("renders ≈ when the two sides are related but not identical", () => {
    const { container } = render(
      <MetricFormula
        terms={[{ label: "فروش خالص", value: 100 }]}
        result={{ label: "دریافتی درگاه‌ها", value: 120, relation: "≈" }}
        note="بر پایه دو تاریخ متفاوت شمرده می‌شوند."
      />,
    );
    expect(container.textContent).toContain("≈دریافتی درگاه‌ها");
    expect(container.textContent).not.toContain("=دریافتی درگاه‌ها");
    expect(screen.getByText("بر پایه دو تاریخ متفاوت شمرده می‌شوند.")).toBeInTheDocument();
  });

  it("counts in the requested format rather than always formatting Toman", () => {
    render(
      <MetricFormula
        terms={[{ label: "سفارش‌ها", value: 24, format: "count" }]}
        result={{ label: "تعداد فروش", value: 33, format: "count" }}
      />,
    );
    expect(screen.getByText("۲۴")).toBeInTheDocument();
    expect(screen.getByText("۳۳")).toBeInTheDocument();
  });
});
