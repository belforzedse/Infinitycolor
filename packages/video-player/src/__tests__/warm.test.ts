import { warmVideo } from "../warm";
import { installMediaStub, uninstallMediaStub } from "./media-stub";

beforeEach(() => installMediaStub());
afterEach(() => {
  jest.restoreAllMocks();
  uninstallMediaStub();
});
it.each([true, false])(
  "warms only the selected progressive format when MP4 capability is %s",
  async (mp4Supported) => {
    jest
      .spyOn(HTMLMediaElement.prototype, "canPlayType")
      .mockImplementation((type) =>
        type.includes("mp4")
          ? mp4Supported
            ? "probably"
            : ""
          : type.includes("webm")
            ? "probably"
            : "",
      );
    const assigned = jest.spyOn(HTMLMediaElement.prototype, "src", "set");
    const controller = new AbortController();
    const source = {
      mp4: "https://cdn.test/a.mp4",
      webm: "https://cdn.test/a.webm",
    };
    const done = warmVideo(source, {
      signal: controller.signal,
      allowHls: false,
    });
    expect(assigned.mock.calls).toEqual([
      [mp4Supported ? source.mp4 : source.webm],
    ]);
    controller.abort();
    await done;
  },
);
