import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import Page from "../page";
import { listIssueReports } from "@/services/issue-reports";

jest.mock("@/components/SuperAdmin/Layout/ContentWrapper", () => ({ __esModule: true, default: ({ children }: any) => <div>{children}</div> }));
jest.mock("@/config/admin-env", () => ({ storefrontOrigin: () => "https://example.com" }));
jest.mock("@/services/issue-reports", () => ({ listIssueReports: jest.fn() }));
jest.mock("zaman", () => ({
  DatePicker: ({ defaultValue, inputAttributes, onChange }: any) => {
    const [value, setValue] = require("react").useState(defaultValue ? "selected" : "");
    return <input {...inputAttributes} value={value} onChange={() => {
      setValue("selected");
      onChange({ value: new Date(2026, 8, 8) });
    }} />;
  },
}));

it("keeps dates optional, sends local day boundaries, and resets the uncontrolled pickers", async () => {
  (listIssueReports as jest.Mock).mockResolvedValue({ items: [], nextCursor: null, hasMore: false });
  render(<Page />);
  await waitFor(() => expect(listIssueReports).toHaveBeenCalled());
  expect(screen.getByLabelText("از تاریخ")).toHaveValue("");
  expect(screen.getByLabelText("تا تاریخ")).toHaveValue("");
  fireEvent.change(screen.getByLabelText("از تاریخ"), { target: { value: "choose" } });
  fireEvent.change(screen.getByLabelText("تا تاریخ"), { target: { value: "choose" } });
  await waitFor(() => expect(listIssueReports).toHaveBeenLastCalledWith(expect.objectContaining({
    from: new Date(2026, 8, 8).toISOString(),
    to: new Date(2026, 8, 8, 23, 59, 59, 999).toISOString(),
  }), expect.anything()));
  fireEvent.click(screen.getByRole("button", { name: /پاک/ }));
  await waitFor(() => expect(screen.getByLabelText("از تاریخ")).toHaveValue(""));
  expect(screen.getByLabelText("تا تاریخ")).toHaveValue("");
  expect(listIssueReports).toHaveBeenLastCalledWith(expect.objectContaining({ from: undefined, to: undefined }), expect.anything());
});
