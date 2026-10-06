import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import AnipoBarcodeLabel from "./AnipoBarcodeLabel";

it("renders a deterministic Code 128 barcode and actual recipient information", () => {
  const props = {
    barcodeNumber: "123456789012345678901234",
    recipientName: "سارا احمدی",
    recipientAddress: "نشانی واقعی گیرنده",
    weight: "۱۲۵۰ گرم",
  };
  const first = renderToStaticMarkup(<AnipoBarcodeLabel {...props} />);
  expect(renderToStaticMarkup(<AnipoBarcodeLabel {...props} />)).toBe(first);
  render(<AnipoBarcodeLabel {...props} />);
  const barcode = screen.getByRole("img", { name: props.barcodeNumber });
  expect(barcode).toHaveAttribute("data-format", "CODE128B");
  expect(barcode.querySelectorAll("rect").length).toBeGreaterThan(40);
  expect(screen.getByText("نشانی واقعی گیرنده")).toBeVisible();
  expect(screen.getByText("۱۲۵۰ گرم")).toBeVisible();
  expect(
    screen.queryByText(/میدا|گرگان|۱۰۰ گرم|کرایه پستی/),
  ).not.toBeInTheDocument();
});

it("rejects a tracking value the encoder would silently alter", () => {
  render(<AnipoBarcodeLabel barcodeNumber="۱۲۳۴۵۶" />);
  expect(screen.getByText("کد رهگیری معتبر نیست")).toBeVisible();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});

it.each(["0000000000", "۰۰۰۰۰۰۰۰۰۰", "٠٠٠٠٠٠٠٠٠٠"])(
  "omits an unknown postal-code placeholder (%s)",
  (postalCode) => {
    render(
      <AnipoBarcodeLabel
        barcodeNumber="123456789012345678901234"
        postalCode={postalCode}
      />,
    );
    expect(screen.queryByText("کدپستی:")).not.toBeInTheDocument();
  },
);
