import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import ProductsCommentsPage from "../page";
import { productReviewService } from "@/services/product/product-review.service";
import type { ProductReview } from "@/services/product/product-review.service";

jest.mock("@/components/SuperAdmin/Layout/ContentWrapper", () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
jest.mock("@/components/Kits/Modal", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/SuperAdmin/Table", () => ({
  SuperAdminTable: ({
    data,
    columns,
  }: {
    data: ProductReview[];
    columns: Array<{
      accessorKey?: string;
      id?: string;
      cell: (ctx: { row: { original: ProductReview } }) => ReactNode;
    }>;
  }) => (
    <div>
      {data.map((row) => (
        <div key={row.id} data-testid={`review-${row.id}`}>
          <span data-testid={`status-${row.id}`}>
            {columns
              .find((column) => column.accessorKey === "Status")
              ?.cell({ row: { original: row } })}
          </span>
          {columns
            .find((column) => column.id === "actions")
            ?.cell({ row: { original: row } })}
        </div>
      ))}
    </div>
  ),
}));
jest.mock("@/services/product/product-review.service", () => ({
  productReviewService: {
    getAllReviews: jest.fn(),
    updateStatus: jest.fn(),
    deleteReview: jest.fn(),
  },
}));
jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn() },
}));

const pendingReview: ProductReview = {
  id: 11,
  Content: "کیف خوبی بود",
  Status: "Need for Review",
  Date: "2026-09-09",
  Rate: 5,
  LikeCounts: 0,
  DislikeCounts: 0,
  createdAt: "2026-09-09T10:00:00.000Z",
  updatedAt: "2026-09-09T10:00:00.000Z",
  user: {
    id: 4,
    phone: "+989121234567",
    user_info: { FirstName: "سارا", LastName: "محمدی" },
  },
};

describe("product comments status updates", () => {
  beforeEach(() => {
    (productReviewService.getAllReviews as jest.Mock).mockResolvedValue({
      data: [pendingReview],
    });
    (productReviewService.updateStatus as jest.Mock).mockResolvedValue({
      data: { ...pendingReview, Status: "Accepted" },
    });
  });

  it("shows the new status without waiting for a refetch", async () => {
    let finishRefetch: ((value: { data: ProductReview[] }) => void) | undefined;
    (productReviewService.getAllReviews as jest.Mock)
      .mockResolvedValueOnce({ data: [pendingReview] })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRefetch = resolve;
          }),
      );

    render(<ProductsCommentsPage />);

    expect(await screen.findByTestId("status-11")).toHaveTextContent("در انتظار تأیید");
    fireEvent.click(screen.getByTitle("تأیید"));

    await waitFor(() =>
      expect(productReviewService.updateStatus).toHaveBeenCalledWith(11, "Accepted"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("status-11")).toHaveTextContent("تأیید شده"),
    );
    await act(async () => {
      finishRefetch?.({ data: [{ ...pendingReview, Status: "Accepted" }] });
    });
  });
});
