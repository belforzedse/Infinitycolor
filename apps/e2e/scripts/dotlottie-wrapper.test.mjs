import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";

const require = createRequire(import.meta.url);
const wrapper = transformSync(
  readFileSync(require.resolve("@lottiefiles/dotlottie-react"), "utf8"),
  {
    format: "cjs",
    loader: "js",
  },
).code;

/** Exercise the shipped wrapper's hooks and player calls, without a real WASM renderer. */
function mountWrapper({ throwOnSpeed = false } = {}) {
  const instances = [];
  const slots = [];
  let cursor = 0;
  let effects = [];
  const changed = (before, after) =>
    !before ||
    before.length !== after.length ||
    before.some((item, i) => !Object.is(item, after[i]));
  const react = {
    useRef(initial) {
      const index = cursor++;
      return (slots[index] ??= { current: initial });
    },
    useCallback(callback, deps) {
      const index = cursor++;
      if (changed(slots[index]?.deps, deps)) slots[index] = { deps, callback };
      return slots[index].callback;
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!changed(slots[index]?.deps, deps)) return;
      const previous = slots[index];
      const next = (slots[index] = { deps });
      effects.push(() => {
        previous?.cleanup?.();
        next.cleanup = effect();
      });
    },
  };
  class Player {
    constructor(config) {
      this.config = config;
      this.speeds = [];
      this.isLoaded = false;
      instances.push(this);
      return new Proxy(this, {
        get: (target, key) => (key in target ? target[key] : () => undefined),
      });
    }
    setSpeed(value) {
      if (throwOnSpeed)
        throw new Error(
          "recursive use of an object detected which would lead to unsafe aliasing in rust",
        );
      this.speeds.push(value);
    }
  }
  const module = { exports: {} };
  runInNewContext(wrapper, {
    module,
    exports: module.exports,
    require(name) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime")
        return { jsx: (type, props) => ({ type, props }) };
      if (name === "@lottiefiles/dotlottie-web")
        return { DotLottie: Player, DotLottieWorker: Player };
      throw new Error(`Unexpected wrapper dependency: ${name}`);
    },
  });
  let canvasRef;
  const canvas = { addEventListener() {}, removeEventListener() {} };
  return {
    instances,
    render(props = {}) {
      cursor = 0;
      effects = [];
      let element = module.exports.DotLottieReact(props);
      while (typeof element.type === "function")
        element = element.type(element.props);
      element = element.props.children;
      if (element.props.ref !== canvasRef) {
        canvasRef?.(null);
        canvasRef = element.props.ref;
        canvasRef(canvas);
      }
      effects.forEach((effect) => effect());
    },
    unmount() {
      slots.forEach((slot) => slot?.cleanup?.());
      canvasRef?.(null);
    },
  };
}

test("default-speed mount and rerender never invoke the unsafe redundant WASM setter", () => {
  const view = mountWrapper({ throwOnSpeed: true });
  view.render({ autoplay: true, loop: true });
  view.render({ autoplay: true, loop: true });
  assert.equal(view.instances.length, 1);
  assert.deepEqual(view.instances[0].speeds, []);
  view.unmount();
});

test("constructor owns the initial explicit speed, while real speed changes still apply", () => {
  const view = mountWrapper();
  view.render({ speed: 2 });
  assert.equal(view.instances[0].config.speed, 2);
  assert.deepEqual(view.instances[0].speeds, []);
  view.render({ speed: 3 });
  view.render({ speed: 3 });
  view.render({});
  assert.deepEqual(view.instances[0].speeds, [3, 1]);
  view.unmount();
});
