import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import tailwind from "eslint-plugin-tailwindcss";

export default [
  { ignores: ["**/coverage/**", "**/.next/**", "**/out/**"] },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    settings: { next: { rootDir: "../../apps/frontend" } },
    plugins: { react, "react-hooks": reactHooks, tailwindcss: tailwind },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/ban-ts-comment": ["warn", { minimumDescriptionLength: 3 }],
      "@typescript-eslint/consistent-type-imports": ["warn", { prefer: "type-imports" }],
      "@typescript-eslint/no-empty-object-type": "warn",
      "@typescript-eslint/no-require-imports": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-unused-expressions": "warn",
      "no-console": "warn",
      "tailwindcss/classnames-order": "warn",
      "tailwindcss/no-custom-classname": "off",
      "no-warning-comments": ["warn", { terms: ["todo", "fixme"], location: "anywhere" }],
      "@next/next/no-html-link-for-pages": "warn",
      "@next/next/no-assign-module-variable": "warn",
      "prefer-const": "warn",
      "react/display-name": "warn",
      "react/no-unescaped-entities": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/use-memo": "warn"
    }
  },
  {
    // The `@repo/auth-core` package root re-exports `bridge-signature.js`,
    // which imports `node:crypto`. Any client module that reaches the root
    // makes Turbopack inject crypto-browserify + buffer + readable-stream
    // (~420 KB raw, never executed) into the shared storefront chunk.
    files: ["**/*.{js,jsx,mjs,ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@repo/auth-core",
              message:
                "Import a subpath instead (@repo/auth-core/iran-phone, /browser, /contracts, /redirects, ...). The package root re-exports bridge-signature, which imports node:crypto and drags crypto-browserify + buffer into client bundles.",
            },
          ],
        },
      ],
    },
  },
  {
    // Storefront code must not import super-admin modules: `@/components/
    // SuperAdmin/Table` alone dragged the admin table, @tanstack/react-table and
    // qs (~106 KB raw) into the shared client bundle of every storefront route.
    // Shared state belongs in `src/atoms/` -- see src/atoms/refreshTable.ts.
    //
    // Scoped by exclusion rather than by an allowlist of storefront paths, so a
    // new directory is guarded by default. The exceptions are the two admin
    // trees themselves plus the files that are deliberately admin-adjacent: the
    // print views, the admin product editor, the admin upsert-page configs and
    // the admin sidebar.
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/components/SuperAdmin/**",
      "src/app/(super-admin)/**",
      "src/app/(print)/**",
      "src/components/Product/add/**",
      "src/config/**",
      "src/constants/superAdminSidebar.tsx",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@repo/auth-core",
              message:
                "Import a subpath instead (@repo/auth-core/iran-phone, /browser, /contracts, /redirects, ...). The package root re-exports bridge-signature, which imports node:crypto and drags crypto-browserify + buffer into client bundles.",
            },
          ],
          patterns: [
            {
              group: ["**/components/SuperAdmin/**", "**/app/(super-admin)/**"],
              message:
                "Storefront code must not import super-admin modules. Move the shared value into src/atoms/ or src/lib/ instead.",
            },
          ],
        },
      ],
    },
  },
];
