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

describe("responsive admin shell", () => {
  it("keeps page content mounted exactly once across breakpoints", () => {
    const mounted = jest.fn();
    const Page = () => {
      useEffect(() => {
        mounted();
      }, []);
      return <main>Admin page</main>;
    };

    const { rerender } = render(
      <ResponsiveAdminShell viewport="desktop">
        <Page />
      </ResponsiveAdminShell>,
    );

    expect(mounted).toHaveBeenCalledTimes(1);

    rerender(
      <ResponsiveAdminShell viewport="tablet">
        <Page />
      </ResponsiveAdminShell>,
    );
    rerender(
      <ResponsiveAdminShell viewport="mobile">
        <Page />
      </ResponsiveAdminShell>,
    );

    expect(mounted).toHaveBeenCalledTimes(1);
  });
});
