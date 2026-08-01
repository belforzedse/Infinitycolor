import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { IdentityRepository } from "./server/identity-repository";
import { ReturnGrantRepository } from "./server/return-grants";

const connectionString = process.env.AUTH_TEST_DATABASE_URL;

test(
  "migration supports concurrent immutable linking and one-time return grants",
  { skip: !connectionString },
  async () => {
    process.env.AUTH_FLOW_SECRET ??=
      "test-only-flow-secret-at-least-32-characters";
    const pool = new Pool({ connectionString, max: 12 });
    const identities = new IdentityRepository(pool);
    const grants = new ReturnGrantRepository(pool);
    const strapiUserId =
      8_000_000_000 + Math.floor(Math.random() * 100_000_000);

    try {
      const links = await Promise.all(
        Array.from({ length: 12 }, () =>
          identities.getOrCreateVerifiedIdentity(strapiUserId),
        ),
      );
      assert.equal(new Set(links.map((link) => link.betterAuthUserId)).size, 1);
      assert.ok(links.every((link) => link.strapiUserId === strapiUserId));

      const linkedUserId = links[0].betterAuthUserId;
      const rows = await pool.query<{ links: string; users: string }>(
        `select
           (select count(*) from auth.strapi_identity_links where strapi_user_id = $1) as links,
           (select count(*) from auth.users where id = $2) as users`,
        [strapiUserId, linkedUserId],
      );
      assert.deepEqual(rows.rows[0], { links: "1", users: "1" });

      const sessionId = randomUUID();
      await pool.query(
        `insert into auth.sessions
          (id, expires_at, token, created_at, updated_at, user_id)
         values ($1, now() + interval '7 days', $2, now(), now(), $3)`,
        [sessionId, randomUUID(), linkedUserId],
      );
      const returnTo = "https://new.infinitycolor.co/account";
      const grant = await grants.create(sessionId, returnTo);
      assert.ok(!grant.includes(sessionId));
      assert.deepEqual(await grants.exchange(grant), { returnTo, sessionId });
      assert.equal(await grants.exchange(grant), null);

      const expiringGrant = await grants.create(sessionId, returnTo);
      await pool.query(
        "update auth.return_grants set expires_at = now() - interval '1 second' where session_id = $1",
        [sessionId],
      );
      assert.equal(await grants.exchange(expiringGrant), null);
    } finally {
      await pool.query("delete from auth.users where email = $1", [
        `strapi-${strapiUserId}@identity.invalid`,
      ]);
      await pool.end();
    }
  },
);
