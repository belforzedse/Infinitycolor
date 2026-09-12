/**
 * story-rail owns the Stories playback state machine and media surface, which are the
 * reliability-critical parts of the feature. They are tested here rather than from
 * `apps/frontend` for two reasons: this package carries its own `react` devDependency, so
 * rendering it under the frontend's Jest resolves two React copies (apps/social already
 * maps around exactly this), and the frontend's global coverage thresholds should not
 * shift because a workspace package gained tests.
 */
module.exports = {
  displayName: "story-rail",
  testEnvironment: "jsdom",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts", "**/__tests__/**/*.test.tsx"],
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json"],
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  moduleNameMapper: {
    // Collapse the duplicate React copies this package's devDependencies would otherwise
    // introduce; two React instances break hooks with an opaque error.
    "^react$": "<rootDir>/node_modules/react",
    "^react/(.*)$": "<rootDir>/node_modules/react/$1",
    "^react-dom$": "<rootDir>/node_modules/react-dom",
    "^react-dom/(.*)$": "<rootDir>/node_modules/react-dom/$1",
  },
  transform: {
    "^.+\\.[jt]sx?$": ["babel-jest", { configFile: require.resolve("./babel.config.cjs") }],
  },
  transformIgnorePatterns: ["/node_modules/(?!react-instagram-stories)"],
};
