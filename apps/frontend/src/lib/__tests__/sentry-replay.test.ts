/**
 * The replay lifecycle was lifted out of `instrumentation-client.ts` so rrweb
 * could be dynamically imported instead of riding in the chunk every storefront
 * route parses. Nothing else exercises it: a mistake in the move would only show
 * up in production, as replay silently never starting or never stopping on a
 * private route. These tests pin the behaviour, not the transport.
 */

import type * as SentryReplay from "../sentry-replay";

type ReplayStub = {
  getRecordingMode: jest.Mock<"buffer" | "session", []>;
  stop: jest.Mock<Promise<void>, []>;
  start: jest.Mock<void, []>;
  startBuffering: jest.Mock<void, []>;
};

const replayIntegration = jest.fn((options: unknown) => ({ name: "Replay", options }));
const addIntegration = jest.fn();
let replay: ReplayStub | null = null;

jest.mock("@sentry/nextjs", () => ({
  addIntegration: (...args: unknown[]) => addIntegration(...args),
  replayIntegration: (options: unknown) => replayIntegration(options),
  getReplay: () => replay,
}));

function makeReplay(mode: "buffer" | "session" = "buffer"): ReplayStub {
  return {
    getRecordingMode: jest.fn(() => mode),
    stop: jest.fn(() => Promise.resolve()),
    start: jest.fn(),
    startBuffering: jest.fn(),
  };
}

async function loadModule() {
  // Module-level latches mean each case needs a fresh copy.
  let loaded!: typeof SentryReplay;
  await jest.isolateModulesAsync(async () => {
    loaded = await import("../sentry-replay");
  });
  return loaded;
}

beforeEach(() => {
  replayIntegration.mockClear();
  addIntegration.mockClear();
  replay = null;
});

describe("updateReplayRoute", () => {
  it("adds the masked replay integration on an allowed public route", async () => {
    replay = makeReplay();
    const { updateReplayRoute } = await loadModule();

    updateReplayRoute("/plp/category/shirt");

    expect(addIntegration).toHaveBeenCalledTimes(1);
    expect(replayIntegration).toHaveBeenCalledWith(
      expect.objectContaining({
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: true,
        networkCaptureBodies: false,
        networkDetailAllowUrls: [],
        beforeAddRecordingEvent: expect.any(Function),
      }),
    );
  });

  it("drops replay hydrate-error breadcrumbs and keeps other recording events", async () => {
    replay = makeReplay();
    const { updateReplayRoute } = await loadModule();

    updateReplayRoute("/plp/category/shirt");

    const options = replayIntegration.mock.calls[0]?.[0] as {
      beforeAddRecordingEvent?: (event: unknown) => unknown;
    };
    expect(options.beforeAddRecordingEvent).toEqual(expect.any(Function));
    expect(
      options.beforeAddRecordingEvent?.({
        type: 5,
        data: { tag: "breadcrumb", payload: { category: "replay.hydrate-error" } },
      }),
    ).toBeNull();
    expect(
      options.beforeAddRecordingEvent?.({
        type: 5,
        data: { tag: "breadcrumb", payload: { category: "navigation" } },
      }),
    ).toEqual({
      type: 5,
      data: { tag: "breadcrumb", payload: { category: "navigation" } },
    });
  });

  it("does not add the integration twice while the route stays allowed", async () => {
    replay = makeReplay();
    const { updateReplayRoute } = await loadModule();

    updateReplayRoute("/pdp/some-product");
    updateReplayRoute("/pdp/some-product");

    expect(addIntegration).toHaveBeenCalledTimes(1);
  });

  it("stops recording when navigating to a route outside the allowlist", async () => {
    replay = makeReplay();
    const { updateReplayRoute } = await loadModule();

    updateReplayRoute("/plp");
    updateReplayRoute("/checkout");

    expect(replay.stop).toHaveBeenCalledTimes(1);
  });

  it("never adds the integration if the first route is not allowed", async () => {
    replay = makeReplay();
    const { updateReplayRoute } = await loadModule();

    updateReplayRoute("/account");

    expect(addIntegration).not.toHaveBeenCalled();
    expect(replayIntegration).not.toHaveBeenCalled();
  });

  it("resumes buffering when returning to an allowed route", async () => {
    replay = makeReplay("buffer");
    const { updateReplayRoute } = await loadModule();

    updateReplayRoute("/plp");
    updateReplayRoute("/cart");
    updateReplayRoute("/plp/category/shirt");
    await Promise.resolve();
    await Promise.resolve();

    expect(replay.startBuffering).toHaveBeenCalledTimes(1);
    expect(replay.start).not.toHaveBeenCalled();
  });

  it("resumes a session recording rather than buffering when that was the mode", async () => {
    replay = makeReplay("session");
    const { updateReplayRoute } = await loadModule();

    updateReplayRoute("/plp");
    updateReplayRoute("/wallet");
    updateReplayRoute("/plp");
    await Promise.resolve();
    await Promise.resolve();

    expect(replay.start).toHaveBeenCalledTimes(1);
    expect(replay.startBuffering).not.toHaveBeenCalled();
  });
});
