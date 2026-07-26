import { assertSafeIntegrationTarget } from "./integration/safety";

const TEST_CONNECTION = {
  host: "docker",
  port: 5432,
  database: "infinity_test",
  username: "infinity_test",
  password: "infinity_test",
};

describe("integration database safety", () => {
  const originalDockerHost = process.env.DOCKER_HOST;
  const originalHostOverride = process.env.TESTCONTAINERS_HOST_OVERRIDE;

  afterEach(() => {
    if (originalDockerHost === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = originalDockerHost;

    if (originalHostOverride === undefined) delete process.env.TESTCONTAINERS_HOST_OVERRIDE;
    else process.env.TESTCONTAINERS_HOST_OVERRIDE = originalHostOverride;
  });

  it("allows GitLab's explicitly configured disposable Testcontainers host", () => {
    process.env.DOCKER_HOST = "tcp://docker:2375";
    process.env.TESTCONTAINERS_HOST_OVERRIDE = "docker";

    expect(() => assertSafeIntegrationTarget(TEST_CONNECTION)).not.toThrow();
  });

  it("rejects a docker hostname without the matching Testcontainers configuration", () => {
    delete process.env.DOCKER_HOST;
    delete process.env.TESTCONTAINERS_HOST_OVERRIDE;

    expect(() => assertSafeIntegrationTarget(TEST_CONNECTION)).toThrow(
      /not a local\/container address/,
    );
  });
});
