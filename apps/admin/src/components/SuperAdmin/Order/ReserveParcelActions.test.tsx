import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import ReserveParcelActions from "./ReserveParcelActions";
import {
  submitAdminParcel,
  checkAdminParcel,
  type AnipoParcelSummary,
} from "@/services/super-admin/orders/reserveGroups";

let mockCapabilities = new Set(["order.print", "order.shipping.manage"]);
jest.mock("@/hooks/useCan", () => ({
  useCan: (capability: string) => mockCapabilities.has(capability),
}));
jest.mock("@/services/super-admin/orders/reserveGroups", () => ({
  submitAdminParcel: jest.fn(),
  checkAdminParcel: jest.fn(),
}));
jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn() },
}));
const parcel: AnipoParcelSummary = {
  groupKey: "parcel-9",
  orderCount: 3,
  eligibleOrderCount: 3,
  recipientName: "سارا احمدی",
  shippingMethodCode: "post",
  isHeld: false,
  state: null,
  barcode: null,
  submittedAt: null,
  lastCheckedAt: null,
  issuedAt: null,
  weight: 1250,
  boxSizeId: 4,
  canSubmit: true,
  canCheck: false,
  canPrintLabel: false,
  blockedReason: null,
};
beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
});
beforeEach(() => {
  mockCapabilities = new Set(["order.print", "order.shipping.manage"]);
  (submitAdminParcel as jest.Mock)
    .mockReset()
    .mockResolvedValue({ issued: false, pending: true });
  (checkAdminParcel as jest.Mock)
    .mockReset()
    .mockResolvedValue({ issued: true });
});

it("uses the parcel weight and box instead of one page member when registering", async () => {
  const onChanged = jest.fn();
  render(
    <ReserveParcelActions
      groupKey={parcel.groupKey}
      parcel={parcel}
      onChanged={onChanged}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "ثبت در آنیپو" }));
  expect(screen.getByRole("spinbutton")).toHaveValue(1250);
  expect(screen.getByRole("combobox")).toHaveValue("4");
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "ثبت در آنیپو",
    }),
  );
  await waitFor(() =>
    expect(submitAdminParcel).toHaveBeenCalledWith("parcel-9", 1250, 4),
  );
  expect(onChanged).toHaveBeenCalledTimes(1);
});

it("checks an existing parcel registration without opening the registration dialog", async () => {
  render(
    <ReserveParcelActions
      groupKey={parcel.groupKey}
      parcel={{ ...parcel, state: "Pending", canSubmit: false, canCheck: true }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "بررسی آنیپو" }));
  await waitFor(() =>
    expect(checkAdminParcel).toHaveBeenCalledWith("parcel-9"),
  );
  expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
});

it("keeps held and conflicted parcels from submitting", () => {
  const view = render(
    <ReserveParcelActions
      groupKey={parcel.groupKey}
      parcel={{ ...parcel, isHeld: true, canSubmit: false }}
    />,
  );
  expect(screen.getByRole("button", { name: "در مهلت رزرو" })).toBeDisabled();
  view.rerender(
    <ReserveParcelActions
      groupKey={parcel.groupKey}
      parcel={{ ...parcel, state: "NeedsAttention", canSubmit: false }}
    />,
  );
  expect(
    screen.getByRole("button", { name: "نیاز به بررسی آنیپو" }),
  ).toBeDisabled();
  expect(submitAdminParcel).not.toHaveBeenCalled();
});

it("gates invoice and shipping actions independently", () => {
  mockCapabilities = new Set(["order.print"]);
  const view = render(
    <ReserveParcelActions groupKey={parcel.groupKey} parcel={parcel} />,
  );
  expect(
    screen.getByRole("link", { name: "چاپ فاکتور کل بسته" }),
  ).toHaveAttribute("href", "/orders/print/reserve/parcel-9");
  expect(
    screen.queryByRole("button", { name: "ثبت در آنیپو" }),
  ).not.toBeInTheDocument();
  mockCapabilities = new Set(["order.shipping.manage"]);
  view.rerender(
    <ReserveParcelActions groupKey={parcel.groupKey} parcel={parcel} />,
  );
  expect(
    screen.queryByRole("link", { name: "چاپ فاکتور کل بسته" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "ثبت در آنیپو" })).toBeEnabled();
});

it("puts label printing and tracking in the parcel menu after issuance", () => {
  render(
    <ReserveParcelActions
      groupKey={parcel.groupKey}
      parcel={{
        ...parcel,
        state: "Issued",
        barcode: "123456789012345678901234",
        canSubmit: false,
        canPrintLabel: true,
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "عملیات بسته" }));
  expect(
    screen.getByRole("menuitem", { name: "چاپ برچسب پستی" }),
  ).toBeVisible();
  expect(screen.getByRole("menuitem", { name: "رهگیری بسته" })).toBeVisible();
});
