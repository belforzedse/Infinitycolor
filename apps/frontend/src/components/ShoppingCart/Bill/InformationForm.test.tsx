import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
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
  const saveAddress = useWatch({ control, name: "saveAddress" });
  return (
    <>
      <span data-testid="selected-address">{address?.name ?? "none"}</span>
      <span data-testid="selected-postal-code">{postalCode ?? ""}</span>
      <span data-testid="save-address">{String(saveAddress)}</span>
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

  it("normalizes Persian/Arabic-Indic digits typed into the phone field", async () => {
    const store = createStore();
    store.set(currentUserAtom, { Phone: "" });

    await act(async () => {
      render(
        <Provider store={store}>
          <InformationFormHarness />
        </Provider>,
      );
    });

    // Field starts disabled until the shopper opts into editing it.
    fireEvent.click(screen.getByRole("button", { name: "ویرایش" }));

    const phoneInput = document.querySelector('input[name="phoneNumber"]') as HTMLInputElement;
    fireEvent.change(phoneInput, { target: { value: "۰۹۱۲۳۴۵۶۷۸۹" } });

    expect(phoneInput).toHaveValue("09123456789");
  });

  it("normalizes Persian/Arabic-Indic digits typed into the postal code field", async () => {
    const store = createStore();
    store.set(currentUserAtom, { Phone: "09123456789" });

    await act(async () => {
      render(
        <Provider store={store}>
          <InformationFormHarness />
        </Provider>,
      );
    });

    const postalInput = document.querySelector('input[name="postalCode"]') as HTMLInputElement;
    fireEvent.change(postalInput, { target: { value: "١٢٣٤٥٦٧٨٩٠" } });

    expect(screen.getByTestId("selected-postal-code")).toHaveTextContent("1234567890");
  });

  it("uses searchable controls for province and city without changing the saved-address picker", async () => {
    // Two addresses so the picker stays visible with its placeholder rather than
    // auto-selecting (auto-select only fires for exactly one saved address).
    mockedUserService.addresses.getAll.mockResolvedValueOnce([
      savedAddress(1, "خیابان اول"),
      savedAddress(2, "خیابان دوم"),
    ]);
    const store = createStore();
    store.set(currentUserAtom, { Phone: "09123456789" });

    await act(async () => {
      render(
        <Provider store={store}>
          <InformationFormHarness />
        </Provider>,
      );
    });

    expect(screen.getByRole("combobox", { name: "استان" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "شهر" })).toBeVisible();
    expect(screen.getByRole("button", { name: "انتخاب آدرس" })).toBeVisible();
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

describe("ShoppingCartBillInformationForm zero-address presentation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedUserService.me.mockResolvedValue(null);
  });

  it("hides the saved-address picker and add-address button once resolved with no saved addresses", async () => {
    mockedUserService.addresses.getAll.mockResolvedValue([]);
    const store = createStore();
    store.set(currentUserAtom, { Phone: "09123456789" });

    await act(async () => {
      render(
        <Provider store={store}>
          <InformationFormHarness />
        </Provider>,
      );
    });

    expect(screen.queryByTestId("checkout-address-select")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "افزودن آدرس" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("add-address-modal")).not.toBeInTheDocument();
    // The inline fields remain as the one way to enter an address.
    expect(document.querySelector('textarea[name="fullAddress"]')).toBeInTheDocument();
    expect(document.querySelector('input[name="postalCode"]')).toBeInTheDocument();
    expect(screen.getByText(/به‌صورت خودکار برای خریدهای بعدی ذخیره می‌شود/)).toBeInTheDocument();
    // The auto-save is implicit, so there is nothing to opt out of.
    expect(screen.queryByLabelText("ذخیره این آدرس برای خریدهای بعدی")).not.toBeInTheDocument();
    expect(screen.getByTestId("save-address")).toHaveTextContent("true");
  });

  it("keeps the saved-address picker visible while the address fetch is still resolving", async () => {
    let resolveAddresses: (value: ReturnType<typeof savedAddress>[]) => void = () => {};
    mockedUserService.addresses.getAll.mockReturnValue(
      new Promise((resolve) => {
        resolveAddresses = resolve;
      }),
    );
    const store = createStore();
    store.set(currentUserAtom, { Phone: "09123456789" });

    render(
      <Provider store={store}>
        <InformationFormHarness />
      </Provider>,
    );

    expect(screen.getByTestId("checkout-address-select")).toBeInTheDocument();

    await act(async () => {
      resolveAddresses([]);
    });

    expect(screen.queryByTestId("checkout-address-select")).not.toBeInTheDocument();
  });

  it("keeps the saved-address picker visible when the address fetch fails", async () => {
    mockedUserService.addresses.getAll.mockRejectedValue(new Error("network error"));
    const store = createStore();
    store.set(currentUserAtom, { Phone: "09123456789" });

    await act(async () => {
      render(
        <Provider store={store}>
          <InformationFormHarness />
        </Provider>,
      );
    });

    expect(screen.getByTestId("checkout-address-select")).toBeInTheDocument();
  });

  it("forces saveAddress back to true once the shopper has no saved addresses, even if it was previously false", async () => {
    // Start with one address, which the auto-select effect hydrates and marks
    // saveAddress=false for (it's already saved). Then simulate it disappearing.
    mockedUserService.addresses.getAll.mockResolvedValueOnce([
      savedAddress(1, "خیابان اول"),
    ]);
    const store = createStore();
    store.set(currentUserAtom, { Phone: "09123456789" });

    await act(async () => {
      render(
        <Provider store={store}>
          <InformationFormHarness />
        </Provider>,
      );
    });

    expect(screen.getByTestId("save-address")).toHaveTextContent("false");

    mockedUserService.addresses.getAll.mockResolvedValueOnce([]);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(screen.queryByTestId("checkout-address-select")).not.toBeInTheDocument();
    expect(screen.getByTestId("save-address")).toHaveTextContent("true");
  });
});
