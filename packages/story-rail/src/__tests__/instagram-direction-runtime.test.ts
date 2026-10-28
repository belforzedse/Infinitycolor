declare const require: { (id: string): any };
declare const __dirname: string;

export {};

const { readFileSync } = require("node:fs") as {
  readFileSync(path: string, encoding: string): string;
};
const { join } = require("node:path") as { join(...paths: string[]): string };
const { runInNewContext } = require("node:vm") as {
  runInNewContext(source: string, context?: Record<string, unknown>): any;
};

type OwnerAction = "next" | "previous";
type DirectionAdapter = {
  itemActionForSide(side: "left" | "right"): OwnerAction;
  ownerActionForPhysicalDelta(deltaX: number): OwnerAction | null;
  cubeTargetForOwner(action: OwnerAction): number;
  faceAngleForOwner(action: OwnerAction): string;
};

const source = readFileSync(
  join(__dirname, "../../scripts/react-instagram-stories-story-viewer.runtime.txt"),
  "utf8",
);
const helperSource = source.slice(0, source.indexOf("var we ="));
const helpers = runInNewContext(
  `${helperSource}; ({
    direction: IC_createDirectionAdapter,
    clamp: IC_clampOwnerDrag,
    decide: IC_decideOwnerCommit,
  })`,
) as {
  direction(dir: "rtl" | "ltr"): DirectionAdapter;
  clamp(
    percentage: number,
    action: OwnerAction | null,
    currentOwner: number,
    ownerCount: number,
  ): number;
  decide(
    percentage: number,
    velocity: number,
    direction: DirectionAdapter,
    currentOwner: number,
    ownerCount: number,
  ): { ownerAction: OwnerAction | null; shouldCommit: boolean };
};

describe("patched viewer direction adapter", () => {
  it.each([
    ["rtl", "left", "next"],
    ["rtl", "right", "previous"],
    ["ltr", "left", "previous"],
    ["ltr", "right", "next"],
  ] as const)("maps %s physical %s to %s item", (dir, side, action) => {
    expect(helpers.direction(dir).itemActionForSide(side)).toBe(action);
  });

  it.each([
    ["rtl", 40, "next"],
    ["rtl", -40, "previous"],
    ["ltr", 40, "previous"],
    ["ltr", -40, "next"],
  ] as const)("maps %s physical delta %s to %s owner", (dir, delta, action) => {
    expect(helpers.direction(dir).ownerActionForPhysicalDelta(delta)).toBe(action);
  });

  it("mirrors cube targets and adjacent face placement as one contract", () => {
    const rtl = helpers.direction("rtl");
    const ltr = helpers.direction("ltr");
    expect({ next: rtl.cubeTargetForOwner("next"), previous: rtl.cubeTargetForOwner("previous") })
      .toEqual({ next: 1, previous: -1 });
    expect({ next: rtl.faceAngleForOwner("next"), previous: rtl.faceAngleForOwner("previous") })
      .toEqual({ next: "-90deg", previous: "90deg" });
    expect({ next: ltr.cubeTargetForOwner("next"), previous: ltr.cubeTargetForOwner("previous") })
      .toEqual({ next: -1, previous: 1 });
    expect({ next: ltr.faceAngleForOwner("next"), previous: ltr.faceAngleForOwner("previous") })
      .toEqual({ next: "90deg", previous: "-90deg" });
  });
});

describe("patched viewer owner gesture decisions", () => {
  const rtl = helpers.direction("rtl");

  it("commits at 28% distance and springs back below it", () => {
    expect(helpers.decide(0.279, 0, rtl, 1, 3).shouldCommit).toBe(false);
    expect(helpers.decide(0.28, 0, rtl, 1, 3)).toEqual({
      ownerAction: "next",
      shouldCommit: true,
    });
  });

  it("commits a short 0.55 px/ms flick in its final physical direction", () => {
    expect(helpers.decide(0.08, 0.55, rtl, 1, 3)).toEqual({
      ownerAction: "next",
      shouldCommit: true,
    });
    expect(helpers.decide(0.4, -0.7, rtl, 1, 3)).toEqual({
      ownerAction: "previous",
      shouldCommit: true,
    });
  });

  it("damps boundary movement and never commits past the first or last owner", () => {
    expect(helpers.clamp(-0.5, "previous", 0, 3)).toBeCloseTo(-0.11);
    expect(helpers.clamp(0.5, "next", 2, 3)).toBeCloseTo(0.11);
    expect(helpers.decide(-0.8, -1, rtl, 0, 3).shouldCommit).toBe(false);
    expect(helpers.decide(0.8, 1, rtl, 2, 3).shouldCommit).toBe(false);
  });
});
