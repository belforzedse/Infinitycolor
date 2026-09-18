import { enqueueSnappayOperation } from "../snappay";

jest.mock("bullmq", () => {
  const add = jest.fn().mockResolvedValue(undefined);
  return {
    Queue: jest.fn().mockImplementation(() => ({
      add,
      close: jest.fn().mockResolvedValue(undefined),
    })),
    __add: add,
  };
});

const mockedAdd = (jest.requireMock("bullmq") as { __add: jest.Mock }).__add;

describe("enqueueSnappayOperation job ids", () => {
  beforeEach(() => {
    mockedAdd.mockClear();
  });

  it("keeps the minute-bucket id for ordinary enqueue", async () => {
    await enqueueSnappayOperation(55, 1, 0);
    expect(mockedAdd).toHaveBeenCalledWith(
      expect.any(String),
      { operationId: 55, retryCount: 1 },
      expect.objectContaining({
        jobId: expect.stringMatching(/^snappay-55-1-\d+$/),
        delay: 0,
      }),
    );
  });

  it("salts the job id so a pull-forward is not swallowed by a delayed retry", async () => {
    await enqueueSnappayOperation(55, 1, 0, { jobIdSalt: "pull" });
    expect(mockedAdd).toHaveBeenCalledWith(
      expect.any(String),
      { operationId: 55, retryCount: 1 },
      expect.objectContaining({
        jobId: expect.stringMatching(/^snappay-55-1-\d+-pull$/),
        delay: 0,
      }),
    );
  });
});
