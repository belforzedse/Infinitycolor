declare const require: { (id: string): any; resolve(id: string): string };
export {};
const { readFileSync } = require("fs") as { readFileSync(path: string, encoding: string): string };
const { dirname, join } = require("path") as {
  dirname(path: string): string;
  join(...paths: string[]): string;
};

const dist = dirname(require.resolve("react-instagram-stories"));

describe("react-instagram-stories patch contract", () => {
  it.each(["index.js", "index.cjs"])("ships the same direction and gesture state machine in %s", (file) => {
    const source = readFileSync(join(dist, file), "utf8");
    expect(source).toContain("function IC_createDirectionAdapter(direction)");
    expect(source).toContain('direction === "rtl"');
    expect(source).toContain('itemActionForSide(side)');
    expect(source).toContain('ownerActionForPhysicalDelta(deltaX)');
    expect(source).toContain('data-transition-state');
    expect(source).toContain('"dragging-owner"');
    expect(source).toContain('"snapping-owner"');
    expect(source).toContain('"dismissing"');
    expect(source).toContain('transitionend');
    expect(source).toContain('onPointerCancel');
    expect(source).toContain('onLostPointerCapture');
    expect(source).toContain('IC_lockDocument');
    expect(source).toContain("labels");
  });

  it.each(["index.d.ts", "index.d.cts"])("exposes the identical public contract in %s", (file) => {
    const declarations = readFileSync(join(dist, file), "utf8");
    expect(declarations).toContain("interface StoryViewerLabels");
    expect(declarations).toContain("dir?: 'rtl' | 'ltr'");
    expect(declarations).toContain("labels?: StoryViewerLabels");
    expect(declarations).toContain("type CustomComponentProps");
  });

  it("keeps timing in both directions while mirroring only the fill origin", () => {
    const css = readFileSync(join(dist, "styles.css"), "utf8");
    expect(css).toMatch(
      /\.story-progress-bar-fill \{[\s\S]*transform-origin: left;[\s\S]*transition: transform 0\.1s linear;[\s\S]*will-change: transform;[\s\S]*\}/,
    );
    expect(css).toContain('.story-viewer[dir="rtl"] .story-progress-bar-fill');
    expect(css).toContain("transform-origin: right");
    expect(css).toContain("inset-inline-end: max(16px, env(safe-area-inset-right))");
    expect(css).toContain("inset-inline-end: max(16px, env(safe-area-inset-left))");
    expect(css).toContain("overscroll-behavior: none");
    expect(css).toContain("left: 0;\n  right: auto;\n  bottom: auto;\n  width: 100vw");
    expect(css).toContain("height: 100dvh");
  });
});
