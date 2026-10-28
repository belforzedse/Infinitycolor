import type { Strapi } from "@strapi/strapi";
import { readProductKeywords } from "../services/product-title-keywords";

function makeStrapi(findMany: jest.Mock): Strapi {
  // No app directory or generated dictionary is needed to serve a cold request.
  return { db: { query: () => ({ findMany }) } } as unknown as Strapi;
}

describe("readProductKeywords", () => {
  it("extracts current database titles without a generated file", async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: 1, Title: "شومیز نخی" },
      { id: 2, Title: "شومیز لینن" },
    ]);

    await expect(readProductKeywords(makeStrapi(findMany))).resolves.toEqual([
      "شومیز", "نخی", "لینن",
    ]);
  });

  it("coalesces concurrent requests only until the database read completes", async () => {
    let finishRead!: (titles: Array<{ id: number; Title: string }>) => void;
    const findMany = jest.fn().mockImplementationOnce(
      () => new Promise((resolve) => { finishRead = resolve; }),
    );
    const strapi = makeStrapi(findMany);
    const first = readProductKeywords(strapi);
    const second = readProductKeywords(strapi);

    expect(second).toBe(first);
    expect(findMany).toHaveBeenCalledTimes(1);

    finishRead([{ id: 1, Title: "شومیز" }]);
    await expect(first).resolves.toEqual(["شومیز"]);
    await expect(second).resolves.toEqual(["شومیز"]);

    findMany.mockResolvedValueOnce([{ id: 1, Title: "کتان" }]);
    await expect(readProductKeywords(strapi)).resolves.toEqual(["کتان"]);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("does not reuse completed results between instances or later requests", async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: 1, Title: "شومیز" }]);
    const firstInstance = makeStrapi(findMany);
    const secondInstance = makeStrapi(findMany);

    await expect(readProductKeywords(firstInstance)).resolves.toEqual(["شومیز"]);
    await expect(readProductKeywords(secondInstance)).resolves.toEqual(["شومیز"]);

    findMany.mockResolvedValue([{ id: 1, Title: "کتان" }]);
    await expect(readProductKeywords(firstInstance)).resolves.toEqual(["کتان"]);
    await expect(readProductKeywords(secondInstance)).resolves.toEqual(["کتان"]);
    expect(findMany).toHaveBeenCalledTimes(4);
  });

  it("propagates a shared database failure and retries instead of caching an empty success", async () => {
    let failRead!: (error: Error) => void;
    const findMany = jest.fn().mockImplementationOnce(
      () => new Promise((_resolve, reject) => { failRead = reject; }),
    );
    const strapi = makeStrapi(findMany);
    const first = readProductKeywords(strapi);
    const second = readProductKeywords(strapi);
    const firstFailure = expect(first).rejects.toThrow("Database unavailable");
    const secondFailure = expect(second).rejects.toThrow("Database unavailable");

    failRead(new Error("Database unavailable"));
    await Promise.all([firstFailure, secondFailure]);

    findMany.mockResolvedValueOnce([{ id: 1, Title: "شومیز" }]);
    await expect(readProductKeywords(strapi)).resolves.toEqual(["شومیز"]);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("does not cache a successful empty catalogue", async () => {
    const findMany = jest.fn().mockResolvedValueOnce([]);
    const strapi = makeStrapi(findMany);

    await expect(readProductKeywords(strapi)).resolves.toEqual([]);

    findMany.mockResolvedValueOnce([{ id: 1, Title: "شومیز" }]);
    await expect(readProductKeywords(strapi)).resolves.toEqual(["شومیز"]);
  });
});
