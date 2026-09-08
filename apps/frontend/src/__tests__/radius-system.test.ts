import { readFileSync } from "node:fs";
import path from "node:path";

const repositoryRoot = path.resolve(process.cwd(), "../..");

function source(relativePath: string): string {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

describe("semantic radius system", () => {
  const scale = [
    ["micro", "4px"],
    ["compact", "8px"],
    ["control", "12px"],
    ["prominent", "16px"],
    ["panel", "24px"],
    ["pill", "9999px"],
  ] as const;

  it.each(scale)("defines and exposes the %s radius token", (name, value) => {
    const sharedStyles = source("packages/ui/src/styles.css");
    const frontendConfig = source("apps/frontend/tailwind.config.ts");
    const adminConfig = source("apps/admin/tailwind.config.ts");
    const authConfig = source("apps/auth/tailwind.config.ts");

    expect(sharedStyles).toContain(`--radius-${name}: ${value};`);
    const tailwindMapping = new RegExp(`${name}: ["']var\\(--radius-${name}\\)["']`);
    expect(frontendConfig).toMatch(tailwindMapping);
    expect(adminConfig).toMatch(tailwindMapping);
    expect(authConfig).toMatch(tailwindMapping);
  });

  it("loads the shared radius values in the central auth application", () => {
    const authLayout = source("apps/auth/src/app/layout.tsx");
    expect(authLayout).toContain('import "@repo/ui/styles.css";');
  });

  it("keeps the legacy radius alias and Infinitycolor palette", () => {
    const sharedStyles = source("packages/ui/src/styles.css");
    const authButton = source("packages/auth-ui/src/Button.tsx");

    expect(sharedStyles).toContain("--radius: var(--radius-compact);");
    expect(sharedStyles).toContain("--infinity-primary: #3d4c6e;");
    expect(authButton).toContain("bg-infinity-primary");
    expect(authButton).not.toContain("bg-brand-primary");
    expect(authButton.toLowerCase()).not.toContain("#b91c1c");
  });

  it.each([
    ["packages/auth-ui/src/Button.tsx", ["rounded-prominent", "rounded-control"]],
    ["packages/auth-ui/src/Input.tsx", ["rounded-control"]],
    ["packages/auth-ui/src/VerificationInput.tsx", ["rounded-control"]],
    ["packages/ui/src/button.tsx", ["rounded-control"]],
    ["packages/ui/src/skeleton.tsx", ["rounded-micro", "rounded-prominent"]],
    ["apps/frontend/src/styles/components.css", ["rounded-prominent", "rounded-control"]],
    ["apps/frontend/src/app/(public)/auth/layout.tsx", ["rounded-panel"]],
    ["apps/frontend/src/app/(public)/auth/complete/AuthCompleteClient.tsx", ["rounded-prominent"]],
    ["apps/frontend/src/components/Kits/Modal.tsx", ["rounded-panel", "rounded-pill"]],
    ["apps/frontend/src/components/Kits/Tabs.tsx", ["rounded-compact", "rounded-prominent"]],
    ["apps/frontend/src/components/Kits/Form/Select.tsx", ["rounded-control", "rounded-prominent"]],
    ["apps/frontend/src/components/ui/card.tsx", ["rounded-prominent"]],
    ["apps/frontend/src/utils/notify.ts", ["--radius-compact"]],
    ["apps/admin/src/app/(auth)/auth/complete/AuthCompleteClient.tsx", ["rounded-prominent"]],
    ["apps/admin/src/components/Kits/Modal.tsx", ["rounded-panel", "rounded-pill"]],
    ["apps/admin/src/components/Kits/Tabs.tsx", ["rounded-compact", "rounded-prominent"]],
    ["apps/admin/src/components/ui/Input.tsx", ["rounded-control"]],
    ["apps/admin/src/components/admin/tokens.ts", ["rounded-prominent", "rounded-control"]],
    ["apps/admin/src/components/admin/StatusBadge.tsx", ["rounded-pill"]],
    ["apps/admin/src/utils/notify.ts", ["--radius-compact"]],
  ] as const)("reuses semantic tokens in %s", (relativePath, expectedTokens) => {
    const contents = source(relativePath);

    expectedTokens.forEach((token) => expect(contents).toContain(token));
  });

  it("does not retain selected hardcoded radii in migrated components", () => {
    const migratedFiles = [
      "packages/auth-ui/src/Button.tsx",
      "packages/auth-ui/src/Checkbox.tsx",
      "packages/auth-ui/src/Input.tsx",
      "packages/auth-ui/src/PasswordInput.tsx",
      "packages/auth-ui/src/PasswordStrength.tsx",
      "packages/auth-ui/src/PhoneInput.tsx",
      "packages/auth-ui/src/VerificationInput.tsx",
      "packages/ui/src/button.tsx",
      "packages/ui/src/skeleton.tsx",
      "apps/frontend/src/components/Kits/ConfirmDialog.tsx",
      "apps/frontend/src/components/Kits/Form/Select.tsx",
      "apps/frontend/src/components/Kits/Modal.tsx",
      "apps/frontend/src/components/Kits/Tabs.tsx",
      "apps/admin/src/components/Kits/ConfirmDialog.tsx",
      "apps/admin/src/components/Kits/Form/Select.tsx",
      "apps/admin/src/components/Kits/Modal.tsx",
      "apps/admin/src/components/Kits/Tabs.tsx",
    ];
    const hardcodedRadius =
      /rounded-\[(?:4|8|10|12|16|24)px\]|border-radius:\s*(?:4|8|10|12|16|24|9999)px/;

    migratedFiles.forEach((relativePath) => {
      expect(source(relativePath)).not.toMatch(hardcodedRadius);
    });
  });

  it.each([
    "apps/frontend/src/app/globals.css",
    "apps/admin/src/app/globals.css",
    "apps/auth/src/app/globals.css",
  ])(
    "removes app-local radius and focus-shape duplication from %s",
    (relativePath) => {
      const contents = source(relativePath);

      expect(contents).not.toContain("--radius: 0.5rem");
      expect(contents).not.toMatch(/outline-offset:\s*2px;\s*border-radius:\s*6px/);
    },
  );
});
