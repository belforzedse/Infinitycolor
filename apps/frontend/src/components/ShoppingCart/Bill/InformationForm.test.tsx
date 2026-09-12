import React from "react";
import { act, render, screen } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { useForm, useWatch } from "react-hook-form";
import ShoppingCartBillInformationForm from "./InformationForm";
import type { FormData } from "./index";
import { currentUserAtom } from "@/lib/atoms/auth";
import { addressesAtom } from "@/atoms/addressesAtom";

const mockedUserService = jest.requireMock("@/services/user").default as {
  addresses: { getAll: jest.Mock };
  me: jest.Mock;
};

const savedAddress = (id: number, fullAddress: string) => ({
  id,
  FullAddress: fullAddress,
  PostalCode: `12345678${id}`,
  Description: "",
  shipping_city: {
    id: 10 + id,
    Title: "تهران",
    shipping_province: { id: 1, Title: "تهران" },
  },
});

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

function AddressProbe({ control }: { control: ReturnType<typeof useForm<FormData>>["control"] }) {
  const address = useWatch({ control, name: "address" });
  const postalCode = useWatch({ control, name: "postalCode" });
  return (
    <>
      <span data-testid="selected-address">{address?.name ?? "none"}</span>
      <span data-testid="selected-postal-code">{postalCode ?? ""}</span>
    </>
  );
}

function InformationFormHarness({ hideAddressFields = false }: { hideAddressFields?: boolean } = {}) {
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
    <>
      <ShoppingCartBillInformationForm
        register={methods.register}
        errors={{}}
        control={methods.control}
        setValue={methods.setValue}
        hideAddressFields={hideAddressFields}
      />
      <AddressProbe control={methods.control} />
    </>
  );
}

describe("ShoppingCartBillInformationForm", () => {
  it("withholds the address block when the order inherits a reserve destination", async () => {
    const store = createStore();
    store.set(currentUserAtom, { Phone: "09123456789" });

    await act(async () => {
      render(
        <Provider store={store}>
          <InformationFormHarness hideAddressFields />
        </Provider>,
      );
    });

    // Contact details and notes still apply to the attached order...
    expect(document.querySelector('input[name="phoneNumber"]')).toBeInTheDocument();
    expect(document.querySelector('textarea[name="notes"]')).toBeInTheDocument();
    // ...but nothing invites an address that finalize would discard.
    expect(screen.queryByTestId("checkout-address-select")).not.toBeInTheDocument();
    expect(document.querySelector('input[name="postalCode"]')).not.toBeInTheDocument();
    expect(document.querySelector('textarea[name="fullAddress"]')).not.toBeInTheDocument();
  });

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

describe("ShoppingCartBillInformationForm address preselection", () => {
  const renderWithAddresses = async (addresses: ReturnType<typeof savedAddress>[]) => {
    mockedUserService.addresses.getAll.mockResolvedValue(addresses);
    const store = createStore();
    store.set(currentUserAtom, { Phone: "09123456789" });
    store.set(addressesAtom, []);

    await act(async () => {
      render(
        <Provider store={store}>
          <InformationFormHarness />
        </Provider>,
      );
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedUserService.me.mockResolvedValue(null);
  });

  it("preselects the address when the shopper has exactly one", async () => {
    await renderWithAddresses([savedAddress(1, "خیابان اول")]);

    expect(screen.getByTestId("selected-address")).toHaveTextContent("خیابان اول");
    // The existing hydrate effect fills the inline fields off the back of the selection.
    expect(screen.getByTestId("selected-postal-code")).toHaveTextContent("123456781");
  });

  it("leaves the choice to the shopper when there is more than one address", async () => {
    await renderWithAddresses([savedAddress(1, "خیابان اول"), savedAddress(2, "خیابان دوم")]);

    expect(screen.getByTestId("selected-address")).toHaveTextContent("none");
  });

  it("selects nothing when there is no saved address", async () => {
    await renderWithAddresses([]);

    expect(screen.getByTestId("selected-address")).toHaveTextContent("none");
  });

  it("ignores an address that is missing its province, since it is not selectable", async () => {
    const incomplete = savedAddress(3, "بدون استان");
    (incomplete.shipping_city as { shipping_province?: unknown }).shipping_province = undefined;
    await renderWithAddresses([incomplete]);

    expect(screen.getByTestId("selected-address")).toHaveTextContent("none");
  });
});

