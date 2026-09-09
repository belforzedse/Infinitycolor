import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import FAQItem from "../FAQItem";

describe("PDP product notes accordion", () => {
  it("shows details immediately when the panel starts open", () => {
    render(
      <FAQItem title="جزئیات محصول" content="نکته مهم برای مشتری" defaultOpen />,
    );

    expect(screen.getByRole("button", { name: /جزئیات محصول/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("نکته مهم برای مشتری")).toBeVisible();
  });

  it("keeps other notes collapsed until they are opened", async () => {
    render(<FAQItem title="شرایط مرجوع" content="شرایط بازگرداندن کالا" />);

    expect(screen.getByRole("button", { name: /شرایط مرجوع/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    await userEvent.click(screen.getByRole("button", { name: /شرایط مرجوع/ }));

    expect(screen.getByRole("button", { name: /شرایط مرجوع/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("شرایط بازگرداندن کالا")).toBeVisible();
  });
});
