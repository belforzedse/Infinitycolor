import React from "react";
import { render, screen } from "@testing-library/react";
import NoData from "../NoData";

// Avoid the category-title fetch firing in the default (non-search) branch.
beforeAll(() => {
  global.fetch = jest.fn(() =>
    Promise.resolve({ json: () => Promise.resolve({ data: [] }) }),
  ) as unknown as typeof fetch;
});

describe("NoData", () => {
  it("echoes the search term when results are from a search", () => {
    render(<NoData searchQuery="کفش ورزشی" />);
    const msg = screen.getByTestId("nodata-search-message");
    expect(msg).toHaveTextContent("«کفش ورزشی»");
  });

  it("shows the category empty message when there is no search term", () => {
    render(<NoData />);
    expect(screen.queryByTestId("nodata-search-message")).not.toBeInTheDocument();
    expect(screen.getByText("محصولی یافت نشد")).toBeInTheDocument();
  });
});
