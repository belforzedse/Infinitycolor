import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import AsyncSearchPicker from "../AsyncSearchPicker";
import type { VariationOption } from "@/services/product/variation-options";

/**
 * These pickers replaced a prefetch-everything-then-filter-locally approach that
 * could only ever see the first 100 rows the backend would return
 * (`rest.maxLimit`), which is why colours late in the alphabet were unfindable.
 * The behaviour worth pinning is that the query reaches the server and that a
 * slow response for an abandoned query cannot overwrite a newer one.
 */
const OPTIONS: VariationOption[] = [
  { id: "1", title: "زرشکی" },
  { id: "2", title: "زرد" },
];

describe("AsyncSearchPicker", () => {
  it("searches the server rather than a prefetched list", async () => {
    const search = jest.fn().mockResolvedValue(OPTIONS);
    render(
      <AsyncSearchPicker
        placeholder="جستجوی رنگ..."
        search={search}
        selectedIds={new Set()}
        onPick={jest.fn()}
      />,
    );

    await userEvent.type(screen.getByPlaceholderText("جستجوی رنگ..."), "زر");

    await waitFor(() => expect(search).toHaveBeenCalledWith("زر"));
    expect(await screen.findByText("زرشکی")).toBeInTheDocument();
  });

  it("does not offer an already-selected option again", async () => {
    const onPick = jest.fn();
    render(
      <AsyncSearchPicker
        placeholder="جستجوی رنگ..."
        search={jest.fn().mockResolvedValue(OPTIONS)}
        selectedIds={new Set(["1"])}
        onPick={onPick}
      />,
    );

    await userEvent.type(screen.getByPlaceholderText("جستجوی رنگ..."), "زر");

    const selected = await screen.findByText("افزوده شده");
    expect(selected).toBeInTheDocument();
    await userEvent.click(screen.getByText("زرشکی"));
    expect(onPick).not.toHaveBeenCalled();

    await userEvent.click(screen.getByText("زرد"));
    expect(onPick).toHaveBeenCalledWith(OPTIONS[1]);
  });

  it("ignores a slow response for a query the user has moved on from", async () => {
    let resolveFirst: (value: VariationOption[]) => void = () => {};
    const search = jest
      .fn()
      .mockImplementationOnce(
        () => new Promise<VariationOption[]>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValue([{ id: "9", title: "آبی" }]);

    render(
      <AsyncSearchPicker
        placeholder="جستجوی رنگ..."
        search={search}
        selectedIds={new Set()}
        onPick={jest.fn()}
        debounceMs={0}
      />,
    );

    const input = screen.getByPlaceholderText("جستجوی رنگ...");
    await userEvent.type(input, "زر");
    await waitFor(() => expect(search).toHaveBeenCalledWith("زر"));

    await userEvent.clear(input);
    await userEvent.type(input, "آب");
    expect(await screen.findByText("آبی")).toBeInTheDocument();

    // The abandoned request lands late; its results must not reappear.
    resolveFirst(OPTIONS);
    await waitFor(() => expect(screen.queryByText("زرشکی")).not.toBeInTheDocument());
    expect(screen.getByText("آبی")).toBeInTheDocument();
  });

  it("offers creation only once a search has resolved with no exact match", async () => {
    const onCreate = jest.fn();
    render(
      <AsyncSearchPicker
        placeholder="جستجوی رنگ..."
        search={jest.fn().mockResolvedValue([])}
        selectedIds={new Set()}
        onPick={jest.fn()}
        onCreate={onCreate}
        createLabel={(query) => `افزودن رنگ «${query}»`}
      />,
    );

    await userEvent.type(screen.getByPlaceholderText("جستجوی رنگ..."), "سرمه‌ای");

    const createButton = await screen.findByText("افزودن رنگ «سرمه‌ای»");
    await userEvent.click(createButton);
    expect(onCreate).toHaveBeenCalledWith("سرمه‌ای");
  });
});
