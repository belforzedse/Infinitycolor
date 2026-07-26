import { render, screen, waitFor } from "@testing-library/react";
import SuperAdminOrderLogs from "../SuperAdminOrderLogs";
import { getOrderAdminActivities } from "@/services/admin-activity";

jest.mock("@/services/admin-activity", () => ({
  getOrderAdminActivities: jest.fn(),
  getProductAdminActivities: jest.fn(),
}));

const mockGet = getOrderAdminActivities as jest.MockedFunction<typeof getOrderAdminActivities>;

describe("SuperAdminOrderLogs (Events tab)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders an activity entry with actor, summary, IP and a readable before/after diff", async () => {
    mockGet.mockResolvedValue({
      data: [
        {
          id: 1,
          ResourceType: "Order",
          ResourceId: "42",
          Action: "StatusChange",
          Title: "وضعیت سفارش تغییر کرد",
          Severity: "info",
          Changes: { Status: { from: "Paying", to: "Started" } },
          PerformedByName: "علی رضایی",
          PerformedByRole: "Superadmin",
          IP: "203.0.113.9",
          createdAt: "2025-01-01T10:00:00.000Z",
        },
      ],
    });

    render(<SuperAdminOrderLogs orderId={42} />);

    await waitFor(() => {
      expect(screen.getByText("وضعیت سفارش تغییر کرد")).toBeInTheDocument();
    });

    // Actor name + translated role (canonical roleLabels.ts)
    expect(screen.getByText(/علی رضایی/)).toBeInTheDocument();
    expect(screen.getByText(/سوپر ادمین/)).toBeInTheDocument();
    // Field label translated + translated before/after status values (no raw JSON)
    expect(screen.getByText(/وضعیت سفارش:/)).toBeInTheDocument();
    expect(screen.getByText("در انتظار پرداخت")).toBeInTheDocument();
    expect(screen.getByText("در حال پردازش")).toBeInTheDocument();
    // Real client IP is shown
    expect(screen.getByText("203.0.113.9")).toBeInTheDocument();
  });

  it("renders an old/raw row (no Title, unknown field) without crashing", async () => {
    mockGet.mockResolvedValue({
      data: [
        {
          id: 9,
          ResourceType: "Order",
          ResourceId: "7",
          Action: "Update",
          // No Title/Message; unknown field key → must fall back gracefully.
          Changes: { LegacyField: { from: "a", to: "b" } },
          createdAt: "2025-01-01T10:00:00.000Z",
        },
      ],
    });

    render(<SuperAdminOrderLogs orderId={7} />);

    await waitFor(() => {
      // Derived headline from action + resource; raw key used as its own label.
      expect(screen.getByText(/LegacyField:/)).toBeInTheDocument();
    });
    // No raw JSON braces leaked into the UI.
    expect(screen.queryByText(/[{}]/)).not.toBeInTheDocument();
  });

  it("invokes the events-change callback with the activity count", async () => {
    const onEventsChange = jest.fn();
    mockGet.mockResolvedValue({
      data: [
        {
          id: 1,
          ResourceType: "Order",
          Action: "Update",
          Title: "سفارش ویرایش شد",
          createdAt: "2025-01-01T10:00:00.000Z",
        },
      ],
    });

    render(<SuperAdminOrderLogs orderId={42} onEventsChange={onEventsChange} />);

    await waitFor(() => {
      expect(onEventsChange).toHaveBeenCalled();
    });
    const lastCall = onEventsChange.mock.calls[onEventsChange.mock.calls.length - 1][0];
    expect(lastCall).toHaveLength(1);
  });

  it("shows the empty state when there are no activities", async () => {
    mockGet.mockResolvedValue({ data: [] });

    render(<SuperAdminOrderLogs orderId={42} />);

    await waitFor(() => {
      expect(screen.getByText("رویدادی ثبت نشده است")).toBeInTheDocument();
    });
  });

  it("shows the loading state initially", () => {
    mockGet.mockReturnValue(new Promise(() => {}));

    render(<SuperAdminOrderLogs orderId={42} />);

    expect(screen.getByText("در حال بارگذاری...")).toBeInTheDocument();
  });

  it("shows an error state when the request fails", async () => {
    mockGet.mockRejectedValue(new Error("boom"));

    render(<SuperAdminOrderLogs orderId={42} />);

    await waitFor(() => {
      expect(screen.getByText("خطا در دریافت رویدادها")).toBeInTheDocument();
    });
  });
});
