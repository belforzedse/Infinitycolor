import { render } from "@testing-library/react";
import { useEffect } from "react";

jest.mock("@/components/SuperAdmin/Layout/Header", () => ({
  __esModule: true,
  default: () => <header />,
}));
jest.mock("@/components/SuperAdmin/Layout/Sidebar", () => ({
  __esModule: true,
  default: () => <aside />,
}));

import { ResponsiveAdminShell } from "../ClientLayout";

function mockMatchMedia(matches: (query: string) => boolean) {
  window.matchMedia = jest.fn().mockImplementation((query: string) => ({
    matches: matches(query),
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    dispatchEvent: jest.fn(),
    onchange: null,
  }));
}

describe("responsive admin shell", () => {
  beforeEach(() => {
    mockMatchMedia(() => false);
  });

  it("keeps page content mounted exactly once across re-renders", () => {
    const mounted = jest.fn();
    const Page = () => {
      useEffect(() => {
        mounted();
      }, []);
      return <main>Admin page</main>;
    };

    const { rerender } = render(
      <ResponsiveAdminShell>
        <Page />
      </ResponsiveAdminShell>,
    );

    expect(mounted).toHaveBeenCalledTimes(1);

    rerender(
      <ResponsiveAdminShell>
        <Page />
      </ResponsiveAdminShell>,
    );
    rerender(
      <ResponsiveAdminShell>
        <Page />
      </ResponsiveAdminShell>,
    );

    expect(mounted).toHaveBeenCalledTimes(1);
  });

  it("lays out with CSS rather than a resolved-viewport prop", () => {
    // Regression guard: layout used to branch on a JS matchMedia result, which
    // meant nothing could render until it resolved. The shell now takes no
    // viewport input at all and expresses every breakpoint in class names.
    expect(ResponsiveAdminShell.length).toBe(1);

    const { container, getByText } = render(
      <ResponsiveAdminShell>
        <main>Admin page</main>
      </ResponsiveAdminShell>,
    );

    expect(getByText("Admin page")).toBeInTheDocument();
    expect(container.firstChild).toHaveClass("md:flex");
  });

  it("does not mount the focus-trapping mobile drawer at desktop widths", () => {
    mockMatchMedia((query) => query.includes("min-width: 768px"));

    const { container } = render(
      <ResponsiveAdminShell>
        <main>Admin page</main>
      </ResponsiveAdminShell>,
    );

    // Only the sticky desktop sidebar instance should exist.
    expect(container.querySelectorAll("aside")).toHaveLength(1);
  });
});
