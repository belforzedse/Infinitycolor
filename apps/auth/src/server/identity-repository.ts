import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { keyedSubjectTag, authEvent } from "./event-logger";

export interface IdentityLink {
  betterAuthUserId: string;
  strapiUserId: number;
}

function assertStrapiUserId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Verified Strapi user ID must be a positive safe integer");
  }
  return value;
}

export class IdentityRepository {
  constructor(private readonly pool: Pool) {}

  async findByBetterAuthUserId(
    betterAuthUserId: string,
  ): Promise<IdentityLink | null> {
    const result = await this.pool.query<{
      better_auth_user_id: string;
      strapi_user_id: string;
    }>(
      `select better_auth_user_id, strapi_user_id
         from auth.strapi_identity_links
        where better_auth_user_id = $1`,
      [betterAuthUserId],
    );
    const row = result.rows[0];
    return row
      ? {
          betterAuthUserId: row.better_auth_user_id,
          strapiUserId: Number(row.strapi_user_id),
        }
      : null;
  }

  async findByStrapiUserId(strapiUserId: number): Promise<IdentityLink | null> {
    assertStrapiUserId(strapiUserId);
    const result = await this.pool.query<{
      better_auth_user_id: string;
      strapi_user_id: string;
    }>(
      `select better_auth_user_id, strapi_user_id
         from auth.strapi_identity_links
        where strapi_user_id = $1`,
      [strapiUserId],
    );
    const row = result.rows[0];
    return row
      ? {
          betterAuthUserId: row.better_auth_user_id,
          strapiUserId: Number(row.strapi_user_id),
        }
      : null;
  }

  async getOrCreateVerifiedIdentity(
    strapiUserIdValue: number,
  ): Promise<IdentityLink> {
    const strapiUserId = assertStrapiUserId(strapiUserIdValue);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1::bigint)", [
        strapiUserId,
      ]);
      const existing = await client.query<{
        better_auth_user_id: string;
        strapi_user_id: string;
      }>(
        `select better_auth_user_id, strapi_user_id
           from auth.strapi_identity_links
          where strapi_user_id = $1`,
        [strapiUserId],
      );
      if (existing.rows[0]) {
        await client.query("commit");
        return {
          betterAuthUserId: existing.rows[0].better_auth_user_id,
          strapiUserId: Number(existing.rows[0].strapi_user_id),
        };
      }

      const betterAuthUserId = randomUUID();
      const now = new Date();
      const syntheticEmail = `strapi-${strapiUserId}@identity.invalid`;
      const inserted = await client.query<{ id: string }>(
        `insert into auth.users
          (id, name, email, email_verified, image, created_at, updated_at)
       values ($1, $2, $3, false, null, $4, $4)
         returning id`,
        [
          betterAuthUserId,
          `Infinity User ${strapiUserId}`,
          syntheticEmail,
          now,
        ],
      );
      if (!inserted.rows[0])
        throw new Error("Synthetic Better Auth identity collision");
      await client.query(
        `insert into auth.strapi_identity_links
          (better_auth_user_id, strapi_user_id, created_at, updated_at)
         values ($1, $2, $3, $3)`,
        [betterAuthUserId, strapiUserId, now],
      );
      await client.query("commit");
      authEvent("identity_link_created", {
        subjectTag: keyedSubjectTag(strapiUserId),
      });
      return { betterAuthUserId, strapiUserId };
    } catch (error) {
      await client.query("rollback");
      if ((error as { code?: string })?.code === "23505") {
        const existing = await this.findByStrapiUserId(strapiUserId);
        if (existing) return existing;
      }
      authEvent("identity_link_collision", {
        subjectTag: keyedSubjectTag(strapiUserId),
        reasonCode: error instanceof Error ? error.name : "UNKNOWN",
      });
      throw error;
    } finally {
      client.release();
    }
  }
}
