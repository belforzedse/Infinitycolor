import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  { settings: { next: { rootDir: "../../apps/social" } } },
  {
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" }
  },
  {
    files: ["src/components/Kits/Modal.tsx"],
    rules: { "react-hooks/set-state-in-effect": "off" }
  },
  {
    files: ["src/hooks/use-network-status.ts"],
    // The state is a three-second presentation pulse derived from Next's external offline signal.
    rules: { "react-hooks/set-state-in-effect": "off" }
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"])
]);
