import React from "react";
import { act, render } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { useForm } from "react-hook-form";
import ShoppingCartBillInformationForm from "./InformationForm";
import type { FormData } from "./index";
import { currentUserAtom } from "@/lib/atoms/auth";

jest.mock("@/services/user", () => ({
  __esModule: true,
  default: {
    addresses: {
      getAll: jest.fn().mockResolvedValue([]),
    },
    me: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock("@/services/location", () => ({
  getProvinces: jest.fn().mockResolvedValue([]),
  getCities: jest.fn().mockResolvedValue([]),
}));

jest.mock("@/components/User/Address/AddAddress", () => ({
  __esModule: true,
  default: () => <div data-testid="add-address-modal" />,
}));

function InformationFormHarness() {
  const methods = useForm<FormData>({
    defaultValues: {
      fullName: "",
      phoneNumber: "",
      address: null,
      province: null,
      city: null,
      postalCode: "",
      saveAddress: true,
      fullAddress: "",
      addressDescription: "",
      notes: "",
    },
  });

  return (
    <ShoppingCartBillInformationForm
      register={methods.register}
      errors={{}}
      control={methods.control}
      setValue={methods.setValue}
    />
  );
}

describe("ShoppingCartBillInformationForm", () => {
  it("uses a numeric input mode for the checkout phone field", async () => {
    const store = createStore();
    store.set(currentUserAtom, { Phone: "09123456789" });

    await act(async () => {
      render(
        <Provider store={store}>
          <InformationFormHarness />
        </Provider>,
      );
    });

    const phoneInput = document.querySelector('input[name="phoneNumber"]');
    expect(phoneInput).toHaveAttribute("inputmode", "numeric");
  });
});
