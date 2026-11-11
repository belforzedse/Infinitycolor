import { render, screen } from "@testing-library/react";
import BaleRecipientSummary from "./BaleRecipientSummary";

it("shows the recipient and address the shopper gave the Bale bot", () => {
  render(
    <BaleRecipientSummary
      recipient={{
        fullName: "علی رضایی",
        phone: "09123456789",
        provinceId: 1,
        provinceTitle: "تهران",
        cityId: 2,
        cityTitle: "تهران",
        postalCode: "1234567890",
        address: "خیابان آزادی، پلاک ۱",
      }}
    />,
  );
  expect(screen.getByRole("heading", { name: "اطلاعات گیرنده" })).toBeInTheDocument();
  expect(screen.getByText("علی رضایی")).toBeInTheDocument();
  expect(screen.getByText("خیابان آزادی، پلاک ۱")).toBeInTheDocument();
  expect(screen.getByText("تهران، تهران")).toBeInTheDocument();
  expect(screen.getByText(/لینک تازه بگیرید/)).toBeInTheDocument();
});
