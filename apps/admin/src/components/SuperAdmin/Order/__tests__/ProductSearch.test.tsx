import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ProductSearch from "../ProductSearch";
import { apiClient } from "@/services";

jest.mock("@/services", () => ({ apiClient: { get: jest.fn() } }));

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

it("lets staff select an unpublished product for a homepage list without public search", async () => {
  const get = apiClient.get as jest.Mock;
  get.mockResolvedValue({ data: [{ id: 71, attributes: { Title: "مانتو پیش‌نویس", Status: "InActive" } }] });
  const fetch = jest.fn();
  global.fetch = fetch;
  const select = jest.fn();
  render(<ProductSearch onProductSelect={select} selectedItems={[]} enableVariationSelection={false} includeUnpublished />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "مانتو" } });
  await screen.findByText("مانتو پیش‌نویس");
  expect(fetch).not.toHaveBeenCalled();
  const [endpoint, options] = get.mock.calls[0];
  const url = new URL(endpoint, "http://local.test");
  expect(url.pathname).toBe("/products");
  expect(url.searchParams.get("filters[$or][0][Title][$containsi]")).toBe("مانتو");
  expect(url.searchParams.get("filters[removedAt][$null]")).toBe("true");
  expect(options).toMatchObject({ cache: "no-store", signal: expect.any(AbortSignal) });
  fireEvent.click(screen.getByRole("button", { name: "انتخاب" }));
  await waitFor(() => expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: 71 })));
});

 it.each(["W00288", "W۰۰۲۸۸"])("preserves compact label-code searches for %s", async (term) => {
  const get = apiClient.get as jest.Mock;
  get.mockReset().mockImplementation(async (endpoint: string) => {
    const query = new URL(endpoint, "http://local.test").searchParams;
    const terms = [...query.entries()].filter(([key]) => key.endsWith("[Title][$containsi]")).map(([, value]) => value);
    return { data: terms.some((value) => "بامبر W 00288".includes(value))
      ? [{id: 72, attributes: {Title: "بامبر W 00288", Status: "InActive"}}] : [] };
  });
  render(<ProductSearch onProductSelect={jest.fn()} selectedItems={[]} enableVariationSelection={false} includeUnpublished />);
  fireEvent.change(screen.getByRole("textbox"), {target: {value: term}});
  expect(await screen.findByText("بامبر W 00288")).toBeInTheDocument();
 });
