import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import Page from "../page";
import { listModelApplications } from "@/services/model-applications";

jest.mock("@/components/SuperAdmin/Layout/ContentWrapper", () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
jest.mock("@/services/model-applications", () => ({
  listModelApplications: jest.fn(),
}));
jest.mock("zaman", () => ({
  DatePicker: ({
    inputAttributes,
  }: {
    inputAttributes?: { placeholder?: string };
  }) => <input {...inputAttributes} />,
}));
jest.mock("@/components/ModelApplications/ApplicationDetails", () => ({
  __esModule: true,
  default: () => null,
}));

it("renders the empty inbox after loading applications", async () => {
  (listModelApplications as jest.Mock).mockResolvedValue({
    items: [],
    nextCursor: null,
    hasMore: false,
  });
  render(<Page />);
  expect(await screen.findByText("درخواستی پیدا نشد.")).toBeInTheDocument();
  expect(listModelApplications).toHaveBeenCalled();
});
