const nextJest = require("next/jest");

const createJestConfig = nextJest({ dir: "./" });

const customJestConfig = {
  collectCoverageFrom: [
    "src/proxy.ts",
    "src/atoms/**/*.{ts,tsx}",
    "src/components/**/*.{ts,tsx}",
    "src/constants/**/*.{ts,tsx}",
    "src/hooks/**/*.{ts,tsx}",
    "src/lib/**/*.{ts,tsx}",
    "src/services/**/*.{ts,tsx}",
    "src/utils/**/*.{ts,tsx}",
    "!src/**/*.d.ts",
    "!src/**/*.test.{ts,tsx}",
    "!src/**/*.spec.{ts,tsx}",
    "!src/**/__tests__/**",
    "!src/**/types/**",
    "!src/**/index.ts",
    "!src/components/Debug/**",
    "!src/components/ui/PWAInstallPrompt.tsx",
    "!src/components/ui/ServiceWorkerRegistration.tsx",
    "!src/constants/build-version.json",
    "!src/utils/haptics-test.ts",
  ],
  coverageProvider: "v8",
  coverageReporters: ["text", "json", "json-summary", "lcov", "cobertura"],
  coverageThreshold: {
    global: {
      statements: 17,
      branches: 40,
      functions: 25,
      lines: 17,
    },
    "src/components/ShoppingCart/Bill/PaymentGateway.tsx": {
      statements: 90,
      branches: 70,
      functions: 50,
      lines: 90,
    },
  },
  moduleDirectories: ["node_modules", "<rootDir>/"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    // `images.loaderFile` is wired by a webpack alias on this exact module at
    // build time, and next/jest does not replicate it -- so without this every
    // <Image> in the suite throws "missing loader prop" while the real build is
    // fine. Mapping it here means the tests exercise the actual loader rather
    // than a mock of it.
    "^next/dist/shared/lib/image-loader$": "<rootDir>/src/utils/arvanImageLoader.ts",
  },
  testEnvironment: "jest-environment-jsdom",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
};

module.exports = createJestConfig(customJestConfig);
