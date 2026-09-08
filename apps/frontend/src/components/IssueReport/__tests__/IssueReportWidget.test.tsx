import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import IssueReportWidget from "../IssueReportWidget";
import { submitIssueReport } from "@/services/issue-reports";

jest.mock("next/navigation", () => ({ usePathname: () => "/products/example" }));
jest.mock("jotai", () => ({ ...jest.requireActual("jotai"), useAtomValue: () => null }));
jest.mock("@/services/issue-reports", () => ({ submitIssueReport: jest.fn() }));
jest.mock("@headlessui/react", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogBackdrop: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DialogPanel: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DialogTitle: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2 {...props}>{children}</h2>
  ),
}));

const submit = submitIssueReport as jest.MockedFunction<typeof submitIssueReport>;

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("شماره تماس"), "09121234567");
  await user.type(screen.getByLabelText("عنوان"), "مشکل در سفارش");
  await user.type(screen.getByLabelText("توضیحات"), "جزئیات مشکل سفارش من");
}

describe("IssueReportWidget", () => {
  beforeEach(() => {
    submit.mockReset();
    submit.mockResolvedValue({
      reportId: "3c63f42d-a6bf-4272-8610-0eb13bb14a90",
      createdAt: "2026-09-08T12:00:00.000Z",
      replayed: false,
    });
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: jest.fn(() => "c7150e5a-8dbb-4a73-9742-8c33ee3a61b7"),
    });
  });

  it("shows only number, title, and description and submits silent technical context", async () => {
    const user = userEvent.setup();
    render(<IssueReportWidget />);

    const trigger = screen.getByRole("button", { name: "گزارش مشکل" });
    expect(trigger).toHaveTextContent("گزارش مشکل");
    expect(trigger).toHaveClass("left-3", "min-h-11", "md:bottom-6", "md:left-6");
    await user.click(trigger);
    expect(screen.getAllByRole("textbox")).toHaveLength(3);
    expect(screen.queryByText(/رمز|کد تأیید|کپچا/i)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "گزارش مشکل" }).closest(".max-w-lg")).toHaveClass(
      "rounded-t-3xl",
      "sm:rounded-3xl",
    );

    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: "ارسال گزارش" }));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit.mock.calls[0][0]).toMatchObject({
      submissionId: "c7150e5a-8dbb-4a73-9742-8c33ee3a61b7",
      number: "09121234567",
      issueName: "مشکل در سفارش",
      description: "جزئیات مشکل سفارش من",
      sourcePath: "/products/example",
      context: {
        language: expect.any(String),
        viewport: { width: expect.any(Number), height: expect.any(Number) },
        screen: {
          width: expect.any(Number),
          height: expect.any(Number),
          pixelRatio: expect.any(Number),
        },
        online: expect.any(Boolean),
      },
    });
    expect(screen.getByText("گزارش شما ثبت شد.")).toBeInTheDocument();
  });

  it("closes cleanly and preserves the form after a recoverable server error", async () => {
    const user = userEvent.setup();
    submit.mockRejectedValueOnce(new Error("تعداد ارسال‌ها زیاد است. کمی بعد دوباره تلاش کنید."));
    render(<IssueReportWidget />);

    await user.click(screen.getByRole("button", { name: "گزارش مشکل" }));
    await user.click(screen.getByRole("button", { name: "بستن" }));
    expect(screen.queryByRole("heading", { name: "گزارش مشکل" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "گزارش مشکل" }));
    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: "ارسال گزارش" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("تعداد ارسال‌ها زیاد است");
    expect(screen.getByLabelText("عنوان")).toHaveValue("مشکل در سفارش");
    expect(screen.getByLabelText("توضیحات")).toHaveValue("جزئیات مشکل سفارش من");
    expect(screen.getByRole("button", { name: "ارسال گزارش" })).toBeEnabled();
  });

  it("reuses one idempotency key and context snapshot for an unchanged retry", async () => {
    const user = userEvent.setup();
    submit.mockRejectedValueOnce(new Error("ارسال گزارش انجام نشد.")).mockResolvedValueOnce({
      reportId: "3c63f42d-a6bf-4272-8610-0eb13bb14a90",
      createdAt: "2026-09-08T12:00:00.000Z",
      replayed: true,
    });
    render(<IssueReportWidget />);

    await user.click(screen.getByRole("button", { name: "گزارش مشکل" }));
    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: "ارسال گزارش" }));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "ارسال گزارش" }));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[1][0].submissionId).toBe(submit.mock.calls[0][0].submissionId);
    expect(submit.mock.calls[1][0].context).toEqual(submit.mock.calls[0][0].context);
    expect(screen.getByText("گزارش شما ثبت شد.")).toBeInTheDocument();
  });

  it("disables duplicate submission while a request is in progress", async () => {
    const user = userEvent.setup();
    let resolveRequest!: (value: Awaited<ReturnType<typeof submitIssueReport>>) => void;
    submit.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    render(<IssueReportWidget />);

    await user.click(screen.getByRole("button", { name: "گزارش مشکل" }));
    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: "ارسال گزارش" }));

    expect(await screen.findByRole("button", { name: "در حال ارسال..." })).toBeDisabled();
    resolveRequest({
      reportId: "3c63f42d-a6bf-4272-8610-0eb13bb14a90",
      createdAt: "2026-09-08T12:00:00.000Z",
      replayed: false,
    });
    expect(await screen.findByText("گزارش شما ثبت شد.")).toBeInTheDocument();
  });

  it("blocks an invalid number before making a request", async () => {
    render(<IssueReportWidget />);
    fireEvent.click(screen.getByRole("button", { name: "گزارش مشکل" }));
    fireEvent.change(screen.getByLabelText("شماره تماس"), { target: { value: "02112345678" } });
    fireEvent.change(screen.getByLabelText("عنوان"), { target: { value: "عنوان" } });
    fireEvent.change(screen.getByLabelText("توضیحات"), { target: { value: "توضیحات" } });
    fireEvent.click(screen.getByRole("button", { name: "ارسال گزارش" }));
    expect(await screen.findByText("شماره تماس معتبر نیست.")).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });
});
