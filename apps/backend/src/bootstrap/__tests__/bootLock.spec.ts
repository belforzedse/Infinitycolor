import { acquireBootLock, BOOT_LOCK_KEY, registerSchemaSyncLock, withBootLock } from "../bootLock";

// A stand-in for Postgres advisory locks: one session holds a key, the others
// retry pg_try_advisory_lock until it is unlocked on that same session.
const fakePostgres = (clientName = "postgres") => {
  const holders = new Map<number, object>();
  const statements: string[] = [];
  let open = 0;
  let failLock: Error | undefined;

  const connect = () => {
    const connection = {
      query: async (text: string, values: unknown[] = []) => {
        statements.push(text);
        const key = values[0] as number;
        if (text.startsWith("SELECT pg_try_advisory_lock")) {
          if (failLock) throw failLock;
          if (holders.has(key) && holders.get(key) !== connection) return { rows: [{ locked: false }] };
          holders.set(key, connection);
          return { rows: [{ locked: true }] };
        } else if (text.startsWith("SELECT pg_advisory_unlock") && holders.get(key) === connection) {
          holders.delete(key);
        }
        return { rows: [] };
      },
    };
    return connection;
  };

  const client = {
    config: { client: clientName },
    acquireConnection: jest.fn(async () => {
      open += 1;
      return connect();
    }),
    releaseConnection: jest.fn(async () => {
      open -= 1;
    }),
  };
  return {
    strapi: { db: { connection: { client } }, log: { info: jest.fn() } },
    client,
    holders,
    statements,
    openConnections: () => open,
    failLockWith: (error: Error) => {
      failLock = error;
    },
  };
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("boot lock", () => {
  afterEach(() => {
    delete process.env.BOOT_LOCK_TIMEOUT_MS;
  });

  it("makes a second boot wait until the first releases", async () => {
    const pg = fakePostgres();
    const releaseFirst = await acquireBootLock(pg.strapi, "the schema sync");

    let secondHasIt = false;
    const second = acquireBootLock(pg.strapi, "the schema sync").then((release) => {
      secondHasIt = true;
      return release;
    });
    await settle();
    expect(secondHasIt).toBe(false);

    await releaseFirst();
    const releaseSecond = await second;
    expect(secondHasIt).toBe(true);
    await releaseSecond();

    expect(pg.holders.size).toBe(0);
    expect(pg.openConnections()).toBe(0);
  });

  it("takes the lock on one connection and unlocks on that same one", async () => {
    const pg = fakePostgres();
    const release = await acquireBootLock(pg.strapi, "the schema sync");
    expect(pg.holders.has(BOOT_LOCK_KEY)).toBe(true);
    await release();
    await release();
    expect(pg.holders.size).toBe(0);
    expect(pg.client.acquireConnection).toHaveBeenCalledTimes(1);
    expect(pg.client.releaseConnection).toHaveBeenCalledTimes(1);
  });

  it("bounds the wait with lock_timeout and resets it afterwards", async () => {
    process.env.BOOT_LOCK_TIMEOUT_MS = "4500";
    const pg = fakePostgres();
    const release = await acquireBootLock(pg.strapi, "the schema sync");
    await release();
    expect(pg.statements).toEqual([
      "SET lock_timeout = 4500",
      "SELECT pg_try_advisory_lock($1) AS locked",
      "SET lock_timeout = DEFAULT",
      "SELECT pg_advisory_unlock($1)",
    ]);
  });

  it("gives its connection back and names the section when the lock times out", async () => {
    const pg = fakePostgres();
    pg.failLockWith(new Error("canceling statement due to lock timeout"));
    await expect(acquireBootLock(pg.strapi, "the database invariants")).rejects.toThrow(
      /boot lock for the database invariants within 300000 ms: canceling statement due to lock timeout/,
    );
    expect(pg.statements).toContain("SET lock_timeout = DEFAULT");
    expect(pg.openConnections()).toBe(0);
  });

  it("bounds retries while another boot holds the lock and returns its connection", async () => {
    const pg = fakePostgres();
    const release = await acquireBootLock(pg.strapi, "the first boot");
    process.env.BOOT_LOCK_TIMEOUT_MS = "25";
    await expect(acquireBootLock(pg.strapi, "the second boot")).rejects.toThrow(
      /boot lock for the second boot within 25 ms: timed out waiting for another boot/,
    );
    expect(pg.holders.size).toBe(1);
    expect(pg.openConnections()).toBe(1);
    await release();
    expect(pg.openConnections()).toBe(0);
  });

  it("releases the lock when the work under it throws", async () => {
    const pg = fakePostgres();
    await expect(
      withBootLock(pg.strapi, "the database invariants", async () => {
        throw new Error("repair failed");
      }),
    ).rejects.toThrow("repair failed");
    expect(pg.holders.size).toBe(0);
    expect(pg.openConnections()).toBe(0);
  });

  it("does nothing on a database that is not Postgres", async () => {
    const pg = fakePostgres("sqlite");
    const release = await acquireBootLock(pg.strapi, "the schema sync");
    await release();
    expect(pg.client.acquireConnection).not.toHaveBeenCalled();
  });

  it("holds the lock from Strapi's beforeSync hook until afterSync", async () => {
    const pg = fakePostgres();
    const handlers: Record<string, Array<() => Promise<void>>> = {};
    const strapi = {
      ...pg.strapi,
      hook: (name: string) => ({
        register: (fn: () => Promise<void>) => {
          (handlers[name] ||= []).push(fn);
        },
      }),
    };
    registerSchemaSyncLock(strapi as never);

    await Promise.all(handlers["strapi::content-types.beforeSync"].map((fn) => fn()));
    expect(pg.holders.has(BOOT_LOCK_KEY)).toBe(true);
    await Promise.all(handlers["strapi::content-types.afterSync"].map((fn) => fn()));
    expect(pg.holders.size).toBe(0);
    expect(pg.openConnections()).toBe(0);
  });
});
