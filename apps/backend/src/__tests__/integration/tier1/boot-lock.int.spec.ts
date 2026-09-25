/**
 * The boot lock (bootstrap/bootLock.ts) against a real Postgres: an advisory
 * lock belongs to one session, a second session blocks in pg_advisory_lock
 * until the first unlocks, and lock_timeout bounds that wait. No Strapi boot:
 * the lock only needs a pool that hands out and takes back connections.
 */
import fs from "node:fs";
import { CONN_FILE, type IntegrationDbConnection } from "../env";
import { acquireBootLock, BOOT_LOCK_KEY } from "../../../bootstrap/bootLock";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Pool } = require("pg");

describe("boot lock on Postgres", () => {
  let pool: any;
  let strapi: any;

  beforeAll(() => {
    const conn: IntegrationDbConnection = JSON.parse(fs.readFileSync(CONN_FILE, "utf8"));
    pool = new Pool({
      host: conn.host,
      port: conn.port,
      database: conn.database,
      user: conn.username,
      password: conn.password,
      max: 4,
    });
    strapi = {
      db: {
        connection: {
          client: {
            config: { client: "postgres" },
            acquireConnection: () => pool.connect(),
            releaseConnection: async (connection: any) => connection.release(),
          },
        },
      },
      log: { info: jest.fn() },
    };
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(() => {
    delete process.env.BOOT_LOCK_TIMEOUT_MS;
  });

  const holders = async (): Promise<number> => {
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid::bigint = $1 AND granted",
      [BOOT_LOCK_KEY],
    );
    return rows[0].n;
  };

  it("makes a second session wait until the first unlocks", async () => {
    const releaseFirst = await acquireBootLock(strapi, "the first boot");
    expect(await holders()).toBe(1);

    let secondHasIt = false;
    const second = acquireBootLock(strapi, "the second boot").then((release) => {
      secondHasIt = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(secondHasIt).toBe(false);

    await releaseFirst();
    const releaseSecond = await second;
    expect(secondHasIt).toBe(true);
    expect(await holders()).toBe(1);
    await releaseSecond();
    expect(await holders()).toBe(0);
  });

  it("gives up after BOOT_LOCK_TIMEOUT_MS and leaves no connection with the short timeout", async () => {
    const releaseFirst = await acquireBootLock(strapi, "the first boot");
    process.env.BOOT_LOCK_TIMEOUT_MS = "300";
    const started = Date.now();
    await expect(acquireBootLock(strapi, "the second boot")).rejects.toThrow(
      /boot lock for the second boot within 300 ms/,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    await releaseFirst();
    expect(await holders()).toBe(0);

    // Every connection the pool holds is back at the server's lock_timeout.
    const connections = await Promise.all([1, 2, 3, 4].map(() => pool.connect()));
    for (const connection of connections) {
      const { rows } = await connection.query("SHOW lock_timeout");
      expect(rows[0].lock_timeout).toBe("0");
      connection.release();
    }
  });
});
