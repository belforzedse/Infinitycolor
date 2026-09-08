import { collectAndroidHints } from "../deviceHints";

const setData = (value: unknown) => Object.defineProperty(navigator, "userAgentData", { configurable: true, value });
afterEach(() => { setData(undefined); jest.useRealTimers(); });
it("only collects the requested Android report fields", async () => {
  const get = jest.fn().mockResolvedValue({ model: "Pixel 9 Pro", platformVersion: "16.0.0", architecture: "arm" });
  setData({ platform: "Android", getHighEntropyValues: get });
  expect(await collectAndroidHints()).toEqual({ androidHints: { model: "Pixel 9 Pro", platformVersion: "16.0.0" } });
  expect(get).toHaveBeenCalledWith(["model", "platformVersion"]);
});
it("does not query unsupported or non-Android browsers", async () => {
  setData(undefined); expect(await collectAndroidHints()).toEqual({});
  const get = jest.fn(); setData({ platform: "macOS", getHighEntropyValues: get });
  expect(await collectAndroidHints()).toEqual({}); expect(get).not.toHaveBeenCalled();
});
it("tolerates denied, empty, and malformed values", async () => {
  const get = jest.fn().mockRejectedValueOnce(new Error("denied")).mockResolvedValueOnce({model:"",platformVersion:""}).mockResolvedValueOnce({model:123,platformVersion:"invalid"});
  setData({ platform: "Android", getHighEntropyValues: get });
  for (let n=0;n<3;n++) expect(await collectAndroidHints()).toEqual({});
});
it("limits the wait for unavailable hints", async () => {
  jest.useFakeTimers(); setData({ platform: "Android", getHighEntropyValues: () => new Promise(() => {}) });
  const result = collectAndroidHints(); await jest.advanceTimersByTimeAsync(300); expect(await result).toEqual({});
});
