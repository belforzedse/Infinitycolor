const nextJest = require("next/jest");

const createJestConfig = nextJest({ dir: "./" });

const customConfig = createJestConfig({
  moduleDirectories: ["node_modules", "<rootDir>/"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    // nuqs ships ESM only (its CommonJS entry just throws), so tests that use
    // the real library — its testing adapter included — load the ESM build,
    // which the transform below compiles.
    "^nuqs$": "<rootDir>/node_modules/nuqs/dist/index.js",
    "^nuqs/adapters/testing$": "<rootDir>/node_modules/nuqs/dist/adapters/testing.js",
  },
  modulePathIgnorePatterns: ["<rootDir>/.next/"],
  testEnvironment: "jest-environment-jsdom",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
});

module.exports = async () => {
  const config = await customConfig();
  return {
    ...config,
    // next/jest ignores every node_modules path; let nuqs (a pnpm path) through.
    transformIgnorePatterns: [
      "/node_modules/(?!(\\.pnpm/nuqs@[^/]+/node_modules/)?nuqs/)",
      ...(config.transformIgnorePatterns || []).filter((pattern) => !pattern.includes("node_modules")),
    ],
  };
};
