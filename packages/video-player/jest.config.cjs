/**
 * The playback engine is exercised against a controllable HTMLMediaElement fake (jsdom
 * has no media pipeline) and a mocked hls.js, so lifecycle, fallback and cleanup rules
 * are tested deterministically. Real decoding is covered by the Playwright specs.
 */
module.exports = {
  displayName: "video-player",
  testEnvironment: "jsdom",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts", "**/__tests__/**/*.test.tsx"],
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json"],
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  moduleNameMapper: {
    "^react$": "<rootDir>/node_modules/react",
    "^react/(.*)$": "<rootDir>/node_modules/react/$1",
    "^react-dom$": "<rootDir>/node_modules/react-dom",
    "^react-dom/(.*)$": "<rootDir>/node_modules/react-dom/$1",
  },
  transform: {
    "^.+\\.[jt]sx?$": ["babel-jest", { configFile: require.resolve("./babel.config.cjs") }],
  },
};
