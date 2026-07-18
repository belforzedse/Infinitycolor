jest.mock("bullmq", () => ({
  UnrecoverableError: class UnrecoverableError extends Error {},
}), { virtual: true });

jest.mock("../../jobs/expireStockReservations", () => ({
  runExpireStockReservationsTick: jest.fn(),
}));
jest.mock("../../jobs/expireReserveOrders", () => ({
  runExpireReserveOrdersTick: jest.fn(),
}));

import { runExpireReserveOrdersTick } from "../../jobs/expireReserveOrders";
import { runExpireStockReservationsTick } from "../../jobs/expireStockReservations";
import {
  ANALYTICS_MAINTENANCE_JOBS,
  COMMERCE_MAINTENANCE_JOBS,
} from "../contracts";
import { processMaintenanceJob } from "../processors";

const mockedRunExpireStockReservationsTick =
  runExpireStockReservationsTick as jest.MockedFunction<typeof runExpireStockReservationsTick>;
const mockedRunExpireReserveOrdersTick =
  runExpireReserveOrdersTick as jest.MockedFunction<typeof runExpireReserveOrdersTick>;

function createMockStrapi() {
  const viewService = {
    flushQueuedCounters: jest.fn().mockResolvedValue(undefined),
  };

  return {
    log: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    service: jest.fn(() => viewService),
  } as any;
}

describe("queue processors", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("dispatches stock reservation expiry jobs to the existing job runner", async () => {
    const strapi = createMockStrapi();
    mockedRunExpireStockReservationsTick.mockResolvedValue({ status: "completed", stats: {} } as any);

    await processMaintenanceJob(strapi, {
      name: COMMERCE_MAINTENANCE_JOBS.stockReservationExpiry,
    } as any);

    expect(mockedRunExpireStockReservationsTick).toHaveBeenCalledWith(strapi);
  });

  it("dispatches reserve-order expiry jobs to the existing job runner", async () => {
    const strapi = createMockStrapi();
    mockedRunExpireReserveOrdersTick.mockResolvedValue({ status: "completed", stats: {} } as any);

    await processMaintenanceJob(strapi, {
      name: COMMERCE_MAINTENANCE_JOBS.reserveOrderExpiry,
    } as any);

    expect(mockedRunExpireReserveOrdersTick).toHaveBeenCalledWith(strapi);
  });

  it("dispatches view-counter flush jobs to the product-view service", async () => {
    const strapi = createMockStrapi();
    const viewService = strapi.service("api::product-view.product-view");

    await processMaintenanceJob(strapi, {
      name: ANALYTICS_MAINTENANCE_JOBS.viewCounterFlush,
    } as any);

    expect(strapi.service).toHaveBeenCalledWith("api::product-view.product-view");
    expect(viewService.flushQueuedCounters).toHaveBeenCalledTimes(1);
  });

  it("fails unknown job names without retrying forever", async () => {
    await expect(
      processMaintenanceJob(createMockStrapi(), { name: "unknown.job" } as any)
    ).rejects.toThrow("Unknown maintenance job: unknown.job");
  });
});
