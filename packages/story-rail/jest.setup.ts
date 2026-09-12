import "@testing-library/jest-dom";

// jsdom implements no media pipeline at all: play/pause/load are unimplemented stubs and
// readyState/videoWidth/duration are read-only zeros. `installMediaStub` in
// src/__tests__/media-stub.ts replaces them per test with a controllable fake, which is
// what lets these tests drive buffering, autoplay rejection and decode failure directly.
if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}
