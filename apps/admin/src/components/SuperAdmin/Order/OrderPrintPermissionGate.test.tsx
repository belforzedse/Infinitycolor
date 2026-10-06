import { act, fireEvent, render, screen } from "@testing-library/react";
import OrderPrintPermissionGate from "./OrderPrintPermissionGate";
import { UserService } from "@/services";

let mockVersion = 0;
let mockAuthListener: () => void;
jest.mock("@/services", () => ({ UserService: { me: jest.fn() } }));
jest.mock("@/lib/central-auth", () => ({
  readAuthStateVersion: () => mockVersion,
  subscribeToAuthState: (listener: () => void) => {
    mockAuthListener = listener;
    return jest.fn();
  },
}));
const me = UserService.me as jest.Mock;
beforeEach(() => {
  jest.clearAllMocks();
  mockVersion = 0;
});

it("loads permissions in a fresh print tab before mounting the label", async () => {
  let resolve!: (value: unknown) => void;
  me.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(
    <OrderPrintPermissionGate>
      <div>برچسب بسته</div>
    </OrderPrintPermissionGate>,
  );
  expect(screen.queryByText("برچسب بسته")).not.toBeInTheDocument();
  expect(screen.queryByText("دسترسی چاپ ندارید")).not.toBeInTheDocument();
  await act(async () => resolve({ capabilities: ["order.print"] }));
  expect(screen.getByText("برچسب بسته")).toBeVisible();
  expect(me).toHaveBeenCalledWith(true);
});

it("withholds the label when the authenticated role cannot print", async () => {
  me.mockResolvedValueOnce({ capabilities: ["order.read"] });
  render(
    <OrderPrintPermissionGate>
      <div>برچسب بسته</div>
    </OrderPrintPermissionGate>,
  );
  expect(await screen.findByText("دسترسی چاپ ندارید")).toBeVisible();
  expect(screen.queryByText("برچسب بسته")).not.toBeInTheDocument();
});

it("offers recovery after a temporary permission lookup failure", async () => {
  me.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({
    capabilities: ["order.print"],
  });
  render(
    <OrderPrintPermissionGate>
      <div>برچسب بسته</div>
    </OrderPrintPermissionGate>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "تلاش دوباره" }));
  expect(await screen.findByText("برچسب بسته")).toBeVisible();
});

it("rechecks permissions and removes the label when the session changes", async () => {
  me.mockResolvedValueOnce({
    capabilities: ["order.print"],
  }).mockResolvedValueOnce({ capabilities: [] });
  render(
    <OrderPrintPermissionGate>
      <div>برچسب بسته</div>
    </OrderPrintPermissionGate>,
  );
  expect(await screen.findByText("برچسب بسته")).toBeVisible();
  await act(async () => {
    mockVersion += 1;
    mockAuthListener();
  });
  expect(await screen.findByText("دسترسی چاپ ندارید")).toBeVisible();
  expect(screen.queryByText("برچسب بسته")).not.toBeInTheDocument();
});
