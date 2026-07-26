/**
 * Backend INTEGRATION test layer.
 *
 * Runs a REAL Strapi against a REAL, disposable Postgres (Testcontainers by
 * default). Separate from the fast mocked unit layer (jest.config.js). Always
 * run in-band: a single shared Strapi instance, one DB.
 */
module.exports = {
  displayName: 'backend-integration',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.int.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  globalSetup: '<rootDir>/src/__tests__/integration/globalSetup.ts',
  globalTeardown: '<rootDir>/src/__tests__/integration/globalTeardown.ts',
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/integration/setup.int.ts'],
  testTimeout: 240000,
  maxWorkers: 1,
  // The real Strapi boot leaves DB pool / async handles; we tear it down in
  // afterAll, but force a clean exit so the runner never hangs in CI.
  forceExit: true,
  // No coverage gate yet — these tests exist to assert real behavior, not to
  // decorate coverage numbers. Gates are revisited once the layer matures.
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        isolatedModules: true,
        types: ['jest', 'node'],
      },
    }],
  },
};
