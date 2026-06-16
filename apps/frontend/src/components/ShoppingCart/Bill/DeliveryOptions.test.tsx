import React from "react";
import { render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import ShoppingCartBillDeliveryOptions from "./DeliveryOptions";
import type { ShippingOption } from "@/services/shipping";
import type { FormData } from "./index";

jest.mock("./CustomRadioGroup", () => ({
  __esModule: true,
  default: ({ options }: any) => (
    <div>
      {options.map((option: any) => (
        <div key={option.id}>{option.content}</div>
      ))}
    </div>
  ),
}));

const methods: ShippingOption[] = [
  {
    id: 1,
    code: "admin-only-rule",
    title: "ارسال ویژه جشنواره",
    price: 12345,
    basePrice: 12345,
    sortOrder: 10,
  },
  {
    id: 2,
    code: "pickup",
    title: "دریافت حضوری",
    price: 0,
    basePrice: 0,
    sortOrder: 20,
  },
];

describe("ShoppingCartBillDeliveryOptions", () => {
  it("renders backend eligible options without title keyword filtering", () => {
    function TestHost() {
      const { control } = useForm<FormData>();
      return <ShoppingCartBillDeliveryOptions shippingMethods={methods} control={control} />;
    }

    render(<TestHost />);

    expect(screen.getByText("ارسال ویژه جشنواره")).toBeInTheDocument();
    expect(screen.getByText("دریافت حضوری")).toBeInTheDocument();
    expect(screen.getByText("12,345 تومان")).toBeInTheDocument();
    expect(screen.getByText("رایگان")).toBeInTheDocument();
  });
});
