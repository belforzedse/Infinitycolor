import { levelCapForPlayer } from "../hls-config";

const LADDER = [
  { width: 360, height: 640 },
  { width: 540, height: 960 },
  { width: 720, height: 1280 },
  { width: 1080, height: 1920 },
];

describe("levelCapForPlayer", () => {
  it("picks the smallest rung that covers the player at device resolution", () => {
    expect(levelCapForPlayer(LADDER, { width: 270, height: 480 }, 1)).toBe(0);
    // A 390x520 post slide on a 3x phone needs 1170x1560: only 1080p covers the width.
    expect(levelCapForPlayer(LADDER, { width: 390, height: 520 }, 3)).toBe(3);
    // 300x400 at 2x needs 600x800: 540 wide falls short, 720x1280 covers it.
    expect(levelCapForPlayer(LADDER, { width: 300, height: 400 }, 2)).toBe(2);
  });

  it("allows the top rung when the player is bigger than every rendition", () => {
    expect(levelCapForPlayer(LADDER, { width: 1600, height: 2400 }, 1)).toBe(3);
  });

  it("leaves the decision to hls.js while the element has no layout", () => {
    expect(levelCapForPlayer(LADDER, { width: 0, height: 0 }, 2)).toBe(-1);
    expect(levelCapForPlayer([], { width: 270, height: 480 }, 1)).toBe(-1);
  });
});
