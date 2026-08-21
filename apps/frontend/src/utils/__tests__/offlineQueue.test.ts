import {
  clearQueue,
  getQueuedActions,
  processQueue,
  queueAction,
  setupOfflineQueueListener,
} from "../offlineQueue";

describe("offline mutation queue", () => {
  beforeEach(() => {
    clearQueue();
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  });

  afterEach(() => clearQueue());

  it("replays a queued mutation exactly once across duplicate reconnect signals", async () => {
    queueAction({ id: "cart-1", type: "cart-add", payload: { productId: 1 } });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processor = jest.fn(() => pending);
    const removeListener = setupOfflineQueueListener(processor);

    window.dispatchEvent(new Event("app:back-online"));
    window.dispatchEvent(new Event("online"));
    await Promise.resolve();
    expect(processor).toHaveBeenCalledTimes(1);

    release();
    await processQueue(processor);
    expect(processor).toHaveBeenCalledTimes(1);
    expect(getQueuedActions()).toEqual([]);
    removeListener();
  });
});
