/**
 * Jest-only transform. The workspace type-checks with TypeScript 7 (the native compiler),
 * which ts-jest 29 cannot drive, and this package is not a Next app so `next/jest`'s SWC
 * pipeline is not available either. Babel strips types for the test run; correctness of
 * the types themselves is covered by `pnpm --filter @repo/story-rail check-types`.
 */
module.exports = {
  presets: [
    ["@babel/preset-env", { targets: { node: "current" } }],
    ["@babel/preset-react", { runtime: "automatic" }],
    "@babel/preset-typescript",
  ],
};
