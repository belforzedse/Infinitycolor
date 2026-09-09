import { fireEvent, render, screen } from "@testing-library/react";
import { Provider } from "jotai";

import { modelHiringModalOpenAtom } from "@/atoms/modelHiring";
import jotaiStore from "@/lib/jotaiStore";

import { FooterNavItem } from "../FooterLink";

describe("FooterNavItem", () => {
  it("opens the hiring modal from درخواست همکاری", () => {
    jotaiStore.set(modelHiringModalOpenAtom, false);

    render(
      <Provider store={jotaiStore}>
        <FooterNavItem link={{ title: "درخواست همکاری", action: "open-model-hiring" }} />
      </Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "درخواست همکاری" }));
    expect(jotaiStore.get(modelHiringModalOpenAtom)).toBe(true);
  });
});
