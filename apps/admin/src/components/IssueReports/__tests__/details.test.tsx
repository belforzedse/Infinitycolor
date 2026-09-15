import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ReportDetails from "../ReportDetails";
import { describeDevice } from "../device";
import {
  getIssueReport,
  setIssueReportStatus,
  type IssueReportDetail,
} from "@/services/issue-reports";

jest.mock("@/services/issue-reports", () => ({
  getIssueReport: jest.fn(),
  setIssueReportStatus: jest.fn(),
}));
jest.mock("@/config/admin-env", () => ({
  storefrontOrigin: () => "https://shop.example",
}));
const get = jest.mocked(getIssueReport);
const save = jest.mocked(setIssueReportStatus);
const iphone =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1";
const report: IssueReportDetail = {
  reportId: "report-one",
  issueName: "مشکل خرید",
  description: "متن گزارش",
  descriptionPreview: "متن",
  status: "new",
  submittedAt: "2026-09-08T12:00:00Z",
  updatedAt: "2026-09-08T12:00:00Z",
  sourcePath: "/pdp/item",
  contactNumber: "+989121234567",
  reporterUserId: null,
  version: 1,
  clientContext: null,
  userAgent: iphone,
};
beforeEach(() => {
  jest.clearAllMocks();
  get.mockResolvedValue(report);
});

it("parses stored device information without guessing an iPhone generation", () => {
  expect(describeDevice(iphone)).toEqual({
    device: "Apple iPhone",
    os: "iOS 17.6",
    deviceNote: "مدل دقیق در دسترس نیست",
    browser: "Mobile Safari 17.6",
  });
  expect(
    describeDevice(
      "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    ).device,
  ).toContain("SM-S918B");
  expect(
    describeDevice(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ),
  ).toMatchObject({
    device: "رایانه",
    os: "Windows 10 / 11",
    browser: "Chrome 120.0.0.0",
  });
  for (const value of [null, undefined, "", "   ", "broken agent"])
    expect(describeDevice(value)).toEqual({
      device: "نامشخص",
      os: "نامشخص",
      browser: "نامشخص",
    });
});

it("shows summaries, links, copy controls and collapsed diagnostics", async () => {
  const user = userEvent.setup();
  render(
    <ReportDetails
      reportId="report-one"
      onClose={jest.fn()}
      onChanged={jest.fn()}
    />,
  );
  expect(await screen.findByText("Apple iPhone")).toBeVisible();
  expect(screen.getByText("جزئیات فنی").closest("details")).not.toHaveAttribute(
    "open",
  );
  await user.click(screen.getByText("جزئیات فنی"));
  expect(screen.getByText("جزئیات فنی").closest("details")).toHaveAttribute(
    "open",
  );
  expect(
    screen.getByRole("link", { name: report.contactNumber }),
  ).toHaveAttribute("href", `tel:${report.contactNumber}`);
  expect(screen.getByRole("link", { name: "/pdp/item" })).toHaveAttribute(
    "href",
    "https://shop.example/pdp/item",
  );
  const clipboard = jest.spyOn(navigator.clipboard, "writeText");
  await user.click(screen.getByRole("button", { name: "کپی نشانی صفحه" }));
  expect(clipboard).toHaveBeenCalledWith("https://shop.example/pdp/item");
  await user.click(screen.getByRole("button", { name: "کپی شناسه گزارش" }));
  expect(clipboard).toHaveBeenCalledWith("report-one");
});

it("does not retain the previous report when switching and permits retry", async () => {
  const { rerender } = render(
    <ReportDetails
      reportId="report-one"
      onClose={jest.fn()}
      onChanged={jest.fn()}
    />,
  );
  await screen.findByText(report.issueName);
  get.mockRejectedValueOnce(new Error("raw backend error"));
  rerender(
    <ReportDetails
      reportId="report-two"
      onClose={jest.fn()}
      onChanged={jest.fn()}
    />,
  );
  expect(screen.queryByText(report.issueName)).not.toBeInTheDocument();
  await screen.findByRole("alert");
  expect(screen.queryByText("raw backend error")).not.toBeInTheDocument();
  get.mockResolvedValueOnce({
    ...report,
    reportId: "report-two",
    issueName: "گزارش دوم",
  });
  fireEvent.click(screen.getByText("تلاش دوباره"));
  expect(await screen.findByText("گزارش دوم")).toBeVisible();
});

it("saves using the report version and refreshes on conflicts", async () => {
  const changed = jest.fn();
  render(
    <ReportDetails
      reportId="report-one"
      onClose={jest.fn()}
      onChanged={changed}
    />,
  );
  await screen.findByText(report.issueName);
  save.mockResolvedValueOnce({ ...report, status: "in_review", version: 2 });
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "in_review" },
  });
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(save).toHaveBeenCalledWith("report-one", "in_review", 1);
  save.mockRejectedValueOnce({ status: 409 });
  get.mockResolvedValueOnce({ ...report, status: "resolved", version: 3 });
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "resolved" },
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "اطلاعات به‌روز شد",
  );
  expect(screen.getByRole("combobox")).toHaveValue("resolved");
});

it("keeps the saved status when updating fails", async () => {
  render(
    <ReportDetails
      reportId="report-one"
      onClose={jest.fn()}
      onChanged={jest.fn()}
    />,
  );
  await screen.findByText(report.issueName);
  save.mockRejectedValueOnce(new Error("private server detail"));
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "resolved" },
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "تغییر وضعیت انجام نشد",
  );
  expect(screen.getByRole("combobox")).toHaveValue("new");
});

it("ignores a late response from the previous report", async () => {
  let resolveFirst!: (value: IssueReportDetail) => void;
  get.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
  );
  const { rerender } = render(
    <ReportDetails
      reportId="report-one"
      onClose={jest.fn()}
      onChanged={jest.fn()}
    />,
  );
  get.mockResolvedValueOnce({
    ...report,
    reportId: "report-two",
    issueName: "گزارش دوم",
  });
  rerender(
    <ReportDetails
      reportId="report-two"
      onClose={jest.fn()}
      onChanged={jest.fn()}
    />,
  );
  await screen.findByText("گزارش دوم");
  resolveFirst(report);
  await waitFor(() =>
    expect(screen.queryByText(report.issueName)).not.toBeInTheDocument(),
  );
});

it("handles Safari's frozen iOS version without claiming exact OS detection", () => {
  for (const frozen of ["18_6", "18_6_2", "18_7"]) {
    const ua = iphone
      .replace("17_6", frozen)
      .replace("Version/17.6", "Version/26.3");
    expect(describeDevice(ua)).toMatchObject({
      os: "iOS 26",
      browser: "Mobile Safari 26.3",
      osNote: expect.stringContaining("برآورد"),
      deviceNote: expect.any(String),
    });
    expect(
      describeDevice(ua.replace("Version/26.3", "CriOS/140.0.0.0")),
    ).toMatchObject({ os: "iOS", osNote: "نسخهٔ دقیق در دسترس نیست" });
  }
  expect(
    describeDevice(
      iphone
        .replace("17_6", "26_0_1")
        .replace("Version/17.6", "CriOS/140.0.0.0"),
    ).os,
  ).toBe("iOS 26.0.1");
});

it("shows the enriched order snapshot with a mismatch warning", async () => {
  get.mockResolvedValue({
    ...report,
    clientContext: { ...report.clientContext, order: { orderId: 111805 } } as never,
    order: {
      id: 111805,
      status: "Started",
      paymentGateway: "SnappPay",
      date: "2026-09-15T09:18:42.464Z",
      items: [
        { id: 158117, productTitle: "وست گلدوزی تدی N 0035", productSku: "WC-1297070-1297075", count: 1, perAmount: 2149000 },
      ],
      reporterMatchesOrder: false,
    },
  });

  render(<ReportDetails reportId="report-one" onClose={jest.fn()} onChanged={jest.fn()} />);

  expect(await screen.findByRole("link", { name: "سفارش #111805" })).toHaveAttribute(
    "href",
    "/orders/edit/111805",
  );
  expect(screen.getByText("وست گلدوزی تدی N 0035")).toBeVisible();
  expect(
    screen.getByText("این سفارش به حساب کاربری گزارش‌دهنده تعلق ندارد."),
  ).toBeVisible();
});

it("falls back to the cart snapshot when no order was found", async () => {
  get.mockResolvedValue({
    ...report,
    clientContext: {
      ...report.clientContext,
      cart: [{ name: "شلوار جین بگ N 0015", sku: "WC-1293833-1293841", quantity: 1, price: 3699000 }],
    } as never,
  });

  render(<ReportDetails reportId="report-one" onClose={jest.fn()} onChanged={jest.fn()} />);

  expect(await screen.findByText("شلوار جین بگ N 0015")).toBeVisible();
  expect(screen.queryByRole("link", { name: /سفارش #/ })).not.toBeInTheDocument();
});

it("hides the purchase section when there is neither an order nor a cart snapshot", async () => {
  render(<ReportDetails reportId="report-one" onClose={jest.fn()} onChanged={jest.fn()} />);
  await screen.findByText(report.issueName);
  expect(screen.queryByText("خرید")).not.toBeInTheDocument();
});

it("uses reported Android hints and hides reduced Android placeholders", () => {
  const ua =
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
  expect(describeDevice(ua)).toMatchObject({ os: "Android" });
  expect(describeDevice(ua).device).not.toContain("K");
  expect(
    describeDevice(ua, { model: "Pixel 9 Pro", platformVersion: "16.0.0" }),
  ).toMatchObject({ device: "Pixel 9 Pro", os: "Android 16.0.0" });
  expect(
    describeDevice(iphone, { model: "Pixel 9 Pro", platformVersion: "16.0.0" })
      .device,
  ).toBe("Apple iPhone");
});
