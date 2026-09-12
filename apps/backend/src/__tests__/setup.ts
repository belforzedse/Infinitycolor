/**
 * Jest setup file - runs before all tests
 */

/// <reference types="jest" />

// Set test environment variables BEFORE any code runs
process.env.NODE_ENV = 'test';
process.env.DATABASE_CLIENT = 'sqlite';
process.env.DATABASE_FILENAME = ':memory:';

// Use staging/test endpoints for external services
process.env.MELLAT_TERMINAL_ID = 'test-terminal-id';
process.env.MELLAT_USERNAME = 'test-username';
process.env.MELLAT_PASSWORD = 'test-password';
process.env.MELLAT_GATEWAY_URL = 'https://test-gateway.example.com/pgw?wsdl'; // Mock endpoint

// SnappPay - inert values; tests must mock external payment calls.
process.env.SNAPPAY_BASE_URL = 'https://snappay.test.invalid';
process.env.SNAPPAY_CLIENT_ID = 'test-snappay-client-id';
process.env.SNAPPAY_CLIENT_SECRET = 'test-snappay-client-secret';
process.env.SNAPPAY_USERNAME = 'test-snappay-username';
process.env.SNAPPAY_PASSWORD = 'test-snappay-password';
process.env.SNAPPAY_RETURN_URL = 'https://storefront.test.invalid/api/snapp/return';
process.env.SNAPPAY_HARDENED_INITIATION_ENABLED = 'true';

process.env.SMS_ENABLED = 'false';
process.env.IP_PANEL_API_BASE_URL = 'https://edge.ippanel.com/v1';
process.env.IP_PANEL_PATTERN_ENDPOINT = '/api/send';
process.env.IP_PANEL_API_URL = ''; // Optional full endpoint override
process.env.IP_PANEL_API_KEY = 'test-api-key';
process.env.IP_PANEL_PATTERN_CODE = 'test-pattern-code';
process.env.IP_PANEL_SENDER = '+983000505';

process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.APP_KEYS = 'test-app-key-for-otp-cooldown';

// Mock strapi global with any type to allow jest mock methods
// This overrides the strapi global from @strapi/types
(global as any).strapi = {
  log: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  service: jest.fn(),
  entityService: {
    findOne: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  db: {
    query: jest.fn(),
    lifecycles: {
      subscribe: jest.fn(),
    },
  },
  plugin: jest.fn((pluginName: string) => {
    if (pluginName === 'users-permissions') {
      return {
        service: jest.fn((serviceName: string) => {
          if (serviceName === 'jwt') {
            return {
              sign: jest.fn((payload) => `mock-jwt-token-${payload.id}`),
              verify: jest.fn((token) => ({ id: 1, phone: '09123456789' })),
            };
          }
        }),
      };
    }
  }),
};

// Mock axios for external API calls
jest.mock('axios');

// Mock Redis client
jest.mock('../index', () => ({
  RedisClient: Promise.resolve({
    isReady: true,
    ping: jest.fn().mockResolvedValue('PONG'),
    get: jest.fn(),
    set: jest.fn(),
    ttl: jest.fn(),
    del: jest.fn(),
    eval: jest.fn(),
    exists: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
    getDel: jest.fn(),
    scanIterator: jest.fn(async function* () {}),
  }),
}));

// Suppress console output during tests
(global as any).console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  // Keep error for debugging
  error: console.error,
};
