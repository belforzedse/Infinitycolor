import React from "react";
import { render, screen } from "@testing-library/react";
import ReturnPolicyArticle from "./ReturnPolicyArticle";
import { RETURNS_CLAUSES, RETURNS_HEADING, RETURNS_INTRO, RETURNS_WHATSAPP } from "@/constants/legal";

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

  it("links the support WhatsApp number in the pre-shipment clause", () => {
    render(<ReturnPolicyArticle />);

    const whatsappLink = screen.getByRole("link", { name: RETURNS_WHATSAPP });
    expect(whatsappLink).toHaveAttribute("href", `https://wa.me/98${RETURNS_WHATSAPP.slice(1)}`);
  });
});
