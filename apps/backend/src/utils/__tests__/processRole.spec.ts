import {
  getProcessRole,
  isWebProcess,
  shouldStartInProcessBackgroundJobs,
  shouldRunWebBootstrapMaintenance,
} from "../processRole";

describe("process role helpers", () => {
  it("defaults to web role", () => {
    expect(getProcessRole({})).toBe("web");
    expect(isWebProcess({})).toBe(true);
  });

  it("skips web bootstrap maintenance and in-process timers for workers", () => {
    const env = { PROCESS_ROLE: "worker" } as NodeJS.ProcessEnv;

    expect(shouldRunWebBootstrapMaintenance(env)).toBe(false);
    expect(shouldStartInProcessBackgroundJobs(["node", "strapi", "start"], env)).toBe(false);
  });

  it("honors DISABLE_BACKGROUND_JOBS and build commands for web containers", () => {
    expect(
      shouldStartInProcessBackgroundJobs(["node", "strapi", "start"], {
        PROCESS_ROLE: "web",
        DISABLE_BACKGROUND_JOBS: "true",
      } as NodeJS.ProcessEnv)
    ).toBe(false);
    expect(
      shouldStartInProcessBackgroundJobs(["node", "strapi", "build"], {
        PROCESS_ROLE: "web",
      } as NodeJS.ProcessEnv)
    ).toBe(false);
  });
});
