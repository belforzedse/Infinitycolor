import React from "react";
import { render, screen } from "@testing-library/react";
import ReturnPolicyArticle from "./ReturnPolicyArticle";
import { RETURNS_CLAUSES, RETURNS_HEADING, RETURNS_INTRO, RETURNS_SUPPORT_NUMBER } from "@/constants/legal";

describe("ReturnPolicyArticle", () => {
  it("renders the exchange and return rules as numbered clauses", () => {
    render(<ReturnPolicyArticle />);

    expect(screen.getByTestId("return-policy")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: RETURNS_HEADING })).toBeInTheDocument();
    expect(screen.getByText(RETURNS_INTRO)).toBeInTheDocument();
    expect(RETURNS_CLAUSES).toHaveLength(10);
    expect(screen.getByText(RETURNS_CLAUSES[0].paragraphs[0])).toBeInTheDocument();
    expect(screen.getByText(RETURNS_CLAUSES[9].paragraphs[0])).toBeInTheDocument();
    expect(screen.getByText(RETURNS_CLAUSES[4].notice ?? "")).toBeInTheDocument();
  });

  it("links the Bale support number in the pre-shipment clause", () => {
    render(<ReturnPolicyArticle />);

    const supportLink = screen.getByRole("link", { name: RETURNS_SUPPORT_NUMBER });
    expect(supportLink).toHaveAttribute("href", `tel:+98${RETURNS_SUPPORT_NUMBER.slice(1)}`);
    expect(screen.queryByText(/واتساپ/)).not.toBeInTheDocument();
  });
});
