import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";

function grantHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface ExchangedReturnGrant {
  returnTo: string;
  sessionId: string;
  sessionToken: string;
  sessionExpiresAt: Date;
}

export class ReturnGrantRepository {
  constructor(private readonly pool: Pool) {}

  async create(sessionId: string, returnTo: string): Promise<string> {
    const grant = randomBytes(32).toString("base64url");
    await this.pool.query(
      `insert into auth.return_grants
        (grant_hash, session_id, return_to, expires_at, created_at)
       values ($1, $2, $3, now() + interval '60 seconds', now())`,
      [grantHash(grant), sessionId, returnTo],
    );
    return grant;
  }

  async exchange(grant: string): Promise<ExchangedReturnGrant | null> {
    if (!/^[A-Za-z0-9_-]{40,80}$/.test(grant)) return null;
    const result = await this.pool.query<{
      return_to: string;
      session_id: string;
      session_token: string;
      session_expires_at: Date;
    }>(
      `with exchanged as (
         delete from auth.return_grants
          where grant_hash = $1
            and expires_at > now()
        returning return_to, session_id
       )
       select exchanged.return_to,
              exchanged.session_id,
              sessions.token as session_token,
              sessions.expires_at as session_expires_at
         from exchanged
         join auth.sessions
           on sessions.id = exchanged.session_id
          and sessions.expires_at > now()`,
      [grantHash(grant)],
    );
    const row = result.rows[0];
    return row
      ? {
          returnTo: row.return_to,
          sessionId: row.session_id,
          sessionToken: row.session_token,
          sessionExpiresAt: row.session_expires_at,
        }
      : null;
  }
}
