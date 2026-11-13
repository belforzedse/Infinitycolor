import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("social production image contract", () => {
  it("builds auth-core before compiling the social application", () => {
    const dockerfile = readFileSync(
      resolve(__dirname, "../../main.Dockerfile"),
      "utf8",
    );
    const authCoreBuild = dockerfile.indexOf(
      "pnpm --filter @repo/auth-core build",
    );
    const socialBuild = dockerfile.indexOf("pnpm run build");

    expect(authCoreBuild).toBeGreaterThan(-1);
    expect(socialBuild).toBeGreaterThan(authCoreBuild);
  });
});
