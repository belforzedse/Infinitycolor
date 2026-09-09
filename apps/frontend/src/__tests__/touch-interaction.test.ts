import { readFileSync } from "node:fs";
import path from "node:path";

const repositoryRoot = path.resolve(process.cwd(), "../..");

function source(relativePath: string): string {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

describe("touch interaction", () => {
  it("does not scale tap targets on coarse pointers", () => {
    const globals = source("apps/frontend/src/app/globals.css");
    const shared = source("packages/ui/src/styles.css");

    expect(globals).toContain("touch-action: manipulation");
    expect(globals).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*a:active,[\s\S]*transform: translateY\(0\.5px\) scale\(0\.985\);/,
    );
    expect(globals).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*\.pressable:active \{[\s\S]*transform: scale\(0\.97\) translateY\(1px\);/,
    );
    expect(shared).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*\.pressable:active \{[\s\S]*transform: scale\(0\.97\) translateY\(1px\);/,
    );
  });

  it("limits the mobile bottom nav hit target to the visible bar", () => {
    const bottomNav = source("apps/frontend/src/components/PLP/BottomNavigation.tsx");
    expect(bottomNav).toContain(
      'className="pointer-events-none fixed inset-x-0 bottom-0 z-[90] lg:hidden"',
    );
    expect(source("apps/frontend/src/components/IssueReport/IssueReportWidget.tsx")).toContain(
      "z-[80]",
    );
    expect(bottomNav).toContain("pointer-events-auto flex w-full flex-col");
    expect(bottomNav).not.toContain(
      'className="pointer-events-auto mx-auto mb-3 max-w-[560px] px-3 pb-[env(safe-area-inset-bottom)] sm:px-5"',
    );
  });
});
