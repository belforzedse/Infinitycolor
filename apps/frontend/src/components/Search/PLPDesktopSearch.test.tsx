import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import PLPDesktopSearch from "./PLPDesktopSearch";
let pathname = "/plp";
jest.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
jest.mock("./SearchSuggestionCard", () => ({ __esModule: true, default: () => null }));
jest.mock("@/lib/browser-failure-diagnostics", () => ({ recordBrowserHandler: jest.fn() }));
beforeEach(() => {
  pathname = "/plp";
  window.history.replaceState({}, "", "/plp");
  localStorage.clear();
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());
it("keeps repeated route and focus notifications stable and dismisses on pathname changes", async () => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
  const view = render(
    <React.StrictMode>
      <PLPDesktopSearch />
    </React.StrictMode>,
  );
  const input = screen.getByRole("combobox");
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "test" } });
  for (let i = 0; i < 50; i += 1) fireEvent(window, new PopStateEvent("popstate"));
  expect(input).toHaveValue("test");
  pathname = "/offer";
  view.rerender(
    <React.StrictMode>
      <PLPDesktopSearch />
    </React.StrictMode>,
  );
  expect(input).toHaveValue("");
  fireEvent.blur(input);
  view.unmount();
  await act(async () => jest.runOnlyPendingTimers());
});
it("cancels a dismissed request and ignores its delayed JSON result", async () => {
  let parse!: (data: unknown) => void;
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: () =>
      new Promise((resolve) => {
        parse = resolve;
      }),
  });
  render(<PLPDesktopSearch />);
  const input = screen.getByRole("combobox");
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "test" } });
  await act(async () => jest.advanceTimersByTime(400));
  expect(fetch).toHaveBeenCalledTimes(1);
  const signal = jest.mocked(fetch).mock.calls[0][1]?.signal;
  fireEvent.keyDown(input, { key: "Escape" });
  expect(signal?.aborted).toBe(true);
  await act(async () => parse({ data: [{ id: 1, attributes: { Title: "stale" } }] }));
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});
