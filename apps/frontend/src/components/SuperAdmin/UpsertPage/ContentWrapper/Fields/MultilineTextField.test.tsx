import React from "react";
import { render, screen } from "@testing-library/react";
import MultilineTextField from "./MultilineTextField";
import { config as orderEditConfig } from "@/app/(super-admin)/super-admin/orders/edit/[id]/config";

describe("MultilineTextField", () => {
  it("applies maxLength when configured for admin note fields", () => {
    render(<MultilineTextField value="" onChange={jest.fn()} maxLength={500} rows={3} />);

    expect(screen.getByRole("textbox")).toHaveAttribute("maxlength", "500");
  });

  it("configures order description and note fields with maxLength", () => {
    const fields = orderEditConfig.config.flatMap((group) =>
      group.sections.flatMap((section) => section.fields),
    );

    expect(fields.find((field) => field.name === "description")).toMatchObject({
      type: "multiline-text",
      maxLength: 500,
    });
    expect(fields.find((field) => field.name === "note")).toMatchObject({
      type: "multiline-text",
      maxLength: 500,
    });
  });
});
