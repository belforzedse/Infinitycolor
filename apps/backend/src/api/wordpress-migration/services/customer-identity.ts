import { createHash } from "node:crypto";
import {
  canonicalCustomerPhone,
  customerPhoneAdvisoryKey,
  customerPhoneStorageVariants,
} from "../../../utils/customerPhoneIdentity";

export const USER_UID = "plugin::users-permissions.user";
export const USER_INFO_UID = "api::local-user-info.local-user-info";
export const ROLE_UID = "plugin::users-permissions.role";

export class MigrationInputError extends Error {
  status: number;
  code: string;

  constructor(code: string, status = 400) {
    super(code);
    this.name = "MigrationInputError";
    this.status = status;
    this.code = code;
  }
}

export const canonicalIranPhone = canonicalCustomerPhone;
export const phoneStorageVariants = customerPhoneStorageVariants;

export function normalizedEmail(value: unknown): string | null {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.slice(0, 255) : null;
}

const optionalText = (value: unknown, max: number): string =>
  String(value ?? "").trim().slice(0, max);

const sourceKeyHash = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const advisoryKey = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest().readBigInt64BE(0).toString();

async function findMany(query: any, where: Record<string, unknown>, trx: any, limit = 2) {
  return query.findMany({ where, limit, transacting: trx } as any) as Promise<any[]>;
}

async function mappingUserId(trx: any, sourceKind: string, sourceKey: string): Promise<number | null> {
  const result = await trx.raw(
    `SELECT user_id
       FROM customer_identity_mappings
      WHERE source_system = 'woocommerce'
        AND source_kind = ?
        AND source_key = ?
      LIMIT 2`,
    [sourceKind, sourceKey],
  );
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  if (rows.length > 1) throw new MigrationInputError("IDENTITY_MAPPING_AMBIGUOUS", 409);
  return rows[0]?.user_id ? Number(rows[0].user_id) : null;
}

async function persistMapping(
  trx: any,
  sourceKind: string,
  sourceKey: string,
  userId: number,
  matchReason: string,
): Promise<void> {
  const result = await trx.raw(
    `INSERT INTO customer_identity_mappings
       (source_system, source_kind, source_key, user_id, match_reason, first_seen_at, last_seen_at)
     VALUES ('woocommerce', ?, ?, ?, ?, now(), now())
     ON CONFLICT (source_system, source_kind, source_key) DO UPDATE
       SET last_seen_at = now(),
           match_reason = EXCLUDED.match_reason
       WHERE customer_identity_mappings.user_id = EXCLUDED.user_id
     RETURNING user_id`,
    [sourceKind, sourceKey, userId, matchReason],
  );
  if (Array.isArray(result?.rows) && result.rows.length === 0) {
    throw new MigrationInputError("IDENTITY_MAPPING_USER_CONFLICT", 409);
  }
}

async function userById(userQuery: any, id: number, trx: any): Promise<any | null> {
  const matches = await findMany(userQuery, { id }, trx);
  if (matches.length > 1) throw new MigrationInputError("USER_ID_AMBIGUOUS", 409);
  return matches[0] || null;
}

async function uniqueUserByLegacySource(userQuery: any, sourceId: string, trx: any): Promise<any | null> {
  const matches = await findMany(
    userQuery,
    { external_source: "wordpress", external_id: sourceId },
    trx,
  );
  if (matches.length > 1) throw new MigrationInputError("USER_SOURCE_ID_AMBIGUOUS", 409);
  return matches[0] || null;
}

async function uniqueUserByPhone(userQuery: any, phone: string, trx: any): Promise<any | null> {
  const matches = await findMany(userQuery, { phone: { $in: phoneStorageVariants(phone) } }, trx);
  if (matches.length > 1) throw new MigrationInputError("USER_PHONE_AMBIGUOUS", 409);
  return matches[0] || null;
}

async function uniqueCustomerRole(strapiInstance: any, trx: any): Promise<any> {
  const roles = await findMany(strapiInstance.db.query(ROLE_UID), { type: "customer" }, trx);
  if (roles.length !== 1) throw new MigrationInputError("CUSTOMER_ROLE_NOT_UNIQUE", 409);
  return roles[0];
}

async function usableEmail(
  userQuery: any,
  email: string | null,
  existingId: number | null,
  trx: any,
): Promise<{ email: string | null; issue: string | null }> {
  if (!email) return { email: null, issue: null };
  const matches = await findMany(userQuery, { email: { $eqi: email } }, trx);
  if (matches.some((candidate) => Number(candidate.id) !== Number(existingId))) {
    return { email: null, issue: "SOURCE_EMAIL_CONFLICT_IGNORED" };
  }
  return { email, issue: null };
}

export interface CustomerIdentityInput {
  kind: "registered" | "guest";
  sourceCustomerId?: string | null;
  sourceOrderId?: string | null;
  phone?: unknown;
  email?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  sourceCreatedAt?: string | null;
  sourceUpdatedAt?: string | null;
  allowPhoneMerge?: boolean;
}

export interface CustomerIdentityResult {
  user: any | null;
  mode: "created" | "updated" | "matched" | "unresolved";
  matchReason: string;
  issues: string[];
}

export async function reconcileCustomerIdentity(
  strapiInstance: any,
  input: CustomerIdentityInput,
  trx: any,
): Promise<CustomerIdentityResult> {
  const phone = canonicalIranPhone(input.phone);
  if (!phone) {
    if (input.kind === "registered") throw new MigrationInputError("USER_PHONE_INVALID");
    return { user: null, mode: "unresolved", matchReason: "guest-phone-invalid", issues: [] };
  }

  const sourceCustomerId = input.kind === "registered"
    ? String(input.sourceCustomerId ?? "").trim()
    : null;
  if (input.kind === "registered" && (!/^\d+$/.test(sourceCustomerId || "") || sourceCustomerId === "0")) {
    throw new MigrationInputError("USER_SOURCE_ID_INVALID");
  }
  const sourceKind = input.kind === "registered" ? "customer" : "guest-phone";
  const sourceKey = input.kind === "registered" ? sourceCustomerId! : sourceKeyHash(phone);
  const locks = [
    advisoryKey(`woocommerce-identity:${sourceKind}:${sourceKey}`),
    customerPhoneAdvisoryKey(phone),
  ].sort();
  for (const lock of locks) await trx.raw("SELECT pg_advisory_xact_lock(?)", [lock]);

  const userQuery = strapiInstance.db.query(USER_UID);
  const mappedId = await mappingUserId(trx, sourceKind, sourceKey);
  const mappedUser = mappedId ? await userById(userQuery, mappedId, trx) : null;
  if (mappedId && !mappedUser) throw new MigrationInputError("IDENTITY_MAPPING_USER_NOT_FOUND", 409);
  const legacySourceUser = sourceCustomerId
    ? await uniqueUserByLegacySource(userQuery, sourceCustomerId, trx)
    : null;
  const phoneUser = await uniqueUserByPhone(userQuery, phone, trx);
  const candidates = [mappedUser, legacySourceUser, phoneUser].filter(Boolean);
  const candidateIds = new Set(candidates.map((candidate) => Number(candidate.id)));
  if (candidateIds.size > 1) throw new MigrationInputError("USER_IDENTITY_CONFLICT", 409);
  let existing = candidates[0] || null;

  const phoneSourceConflict = Boolean(
    input.kind === "registered" &&
    !mappedUser &&
    phoneUser?.external_source === "wordpress" &&
    String(phoneUser.external_id || "") !== sourceCustomerId,
  );
  if (phoneSourceConflict) {
    if (!input.allowPhoneMerge) throw new MigrationInputError("USER_PHONE_SOURCE_CONFLICT", 409);
    // A claimed account belongs to a real person who took it over; their balance
    // is not ours to merge into, even when the caller opted in.
    if (phoneUser.ClaimedAt || phoneUser.IsVerified) {
      throw new MigrationInputError("USER_PHONE_MERGE_CLAIMED", 409);
    }
    // The owner keeps its own external_id — reassigning it would orphan that
    // account's source identity. The mapping row written below is what makes
    // this legacy id resolve here on every later run.
  }

  const existingPhone = canonicalIranPhone(existing?.phone);
  if (existing && existingPhone && existingPhone !== phone) {
    if (existing.ClaimedAt || existing.IsVerified) {
      throw new MigrationInputError("USER_CLAIMED_PHONE_CONFLICT", 409);
    }
    if (phoneUser && Number(phoneUser.id) !== Number(existing.id)) {
      throw new MigrationInputError("USER_PHONE_CONFLICT", 409);
    }
  }

  const sourceEmail = normalizedEmail(input.email);
  const emailResolution = await usableEmail(userQuery, sourceEmail, existing?.id || null, trx);
  const issues = emailResolution.issue ? [emailResolution.issue] : [];
  const profileManaged = existing?.ProfileManagedByCustomer === true;
  const firstName = optionalText(input.firstName, 255);
  const lastName = optionalText(input.lastName, 255);
  const accountOrigin = input.kind === "registered" ? "WooRegistered" : "WooGuest";
  const fallbackEmail = `${input.kind === "registered" ? `wp-${sourceKey}` : `guest-${sourceKey.slice(0, 24)}`}@identity.invalid`;

  let matchReason = mappedUser
    ? "source-mapping"
    : legacySourceUser
      ? "legacy-source-id"
      : phoneSourceConflict
        ? "phone-merge"
        : phoneUser
          ? "canonical-phone"
          : "preprovisioned";
  let mode: CustomerIdentityResult["mode"];
  const wasCreated = !existing;
  if (!existing) {
    const role = await uniqueCustomerRole(strapiInstance, trx);
    const data = {
      username: phone,
      email: emailResolution.email || fallbackEmail,
      phone,
      provider: "local",
      confirmed: true,
      blocked: false,
      IsActive: true,
      IsVerified: false,
      role: role.id,
      AccountOrigin: accountOrigin,
      ClaimedAt: null,
      ProfileCompletedAt: null,
      ProfileManagedByCustomer: false,
      SourceCreatedAt: input.sourceCreatedAt || null,
      SourceUpdatedAt: input.sourceUpdatedAt || null,
      ...(input.kind === "registered"
        ? { external_source: "wordpress", external_id: sourceCustomerId }
        : { external_source: "woocommerce-guest", external_id: sourceKey }),
    };
    existing = await userQuery.create({ data, transacting: trx } as any);
    mode = "created";
  } else {
    const data: Record<string, unknown> = input.kind === "registered"
      ? {
          SourceCreatedAt: input.sourceCreatedAt || existing.SourceCreatedAt || null,
          SourceUpdatedAt: input.sourceUpdatedAt || existing.SourceUpdatedAt || null,
        }
      : {};
    if (!existing.AccountOrigin) {
      data.AccountOrigin = existing.external_source === "wordpress" ? "WooRegistered" : accountOrigin;
    } else if (existing.AccountOrigin === "WooGuest" && input.kind === "registered") {
      data.AccountOrigin = "WooRegistered";
    }
    if (!existing.ClaimedAt && !existing.IsVerified) {
      data.phone = phone;
      data.username = phone;
    }
    if (
      !profileManaged &&
      emailResolution.email &&
      (input.kind === "registered" || !existing.email || String(existing.email).endsWith("@identity.invalid"))
    ) data.email = emailResolution.email;
    if (
      input.kind === "registered" &&
      (!existing.external_source || existing.external_source === "woocommerce-guest")
    ) {
      data.external_source = "wordpress";
      data.external_id = sourceCustomerId;
    }
    if (Object.keys(data).length > 0) {
      existing = await userQuery.update({ where: { id: existing.id }, data, transacting: trx } as any);
      mode = "updated";
    } else {
      mode = "matched";
    }
  }

  const infoQuery = strapiInstance.db.query(USER_INFO_UID);
  const infos = await findMany(infoQuery, { user: existing.id }, trx);
  if (infos.length > 1) throw new MigrationInputError("USER_INFO_AMBIGUOUS", 409);
  if (!profileManaged) {
    const infoData: Record<string, unknown> = { user: existing.id };
    if (wasCreated || input.kind === "registered" || !optionalText(infos[0]?.FirstName, 255)) {
      infoData.FirstName = firstName;
    }
    if (wasCreated || input.kind === "registered" || !optionalText(infos[0]?.LastName, 255)) {
      infoData.LastName = lastName;
    }
    if (infos[0]) {
      if (Object.keys(infoData).length > 1) {
        await infoQuery.update({ where: { id: infos[0].id }, data: infoData, transacting: trx } as any);
      }
    } else {
      await infoQuery.create({ data: infoData, transacting: trx } as any);
    }
  } else if (!infos[0]) {
    await infoQuery.create({ data: { user: existing.id }, transacting: trx } as any);
  }

  await persistMapping(trx, sourceKind, sourceKey, Number(existing.id), matchReason);
  return { user: existing, mode, matchReason, issues };
}

/**
 * Resolve the account a legacy WordPress customer id now lives on, honouring a
 * phone-merge mapping. Wallets must not resolve by `external_id` alone: a merged
 * holder keeps the owner account's own external_id, so the mapping row is the
 * only link back to their legacy id.
 */
export async function resolveUserForLegacySource(
  strapiInstance: any,
  sourceId: string,
  trx: any,
): Promise<any | null> {
  const userQuery = strapiInstance.db.query(USER_UID);
  const mappedId = await mappingUserId(trx, "customer", sourceId);
  const mapped = mappedId ? await userById(userQuery, mappedId, trx) : null;
  if (mapped) return mapped;
  return uniqueUserByLegacySource(userQuery, sourceId, trx);
}

export async function resolveRegisteredCustomerForOrder(
  strapiInstance: any,
  sourceCustomerId: string,
  trx: any,
  sourceProfile?: { firstName?: unknown; lastName?: unknown },
): Promise<any> {
  const userQuery = strapiInstance.db.query(USER_UID);
  const mappedId = await mappingUserId(trx, "customer", sourceCustomerId);
  const mapped = mappedId ? await userById(userQuery, mappedId, trx) : null;
  const legacy = await uniqueUserByLegacySource(userQuery, sourceCustomerId, trx);
  if (mapped && legacy && Number(mapped.id) !== Number(legacy.id)) {
    throw new MigrationInputError("ORDER_CUSTOMER_MAPPING_CONFLICT", 409);
  }
  const user = mapped || legacy;
  if (!user) throw new MigrationInputError("ORDER_CUSTOMER_NOT_FOUND", 409);
  if (!user.ProfileManagedByCustomer && sourceProfile) {
    const infoQuery = strapiInstance.db.query(USER_INFO_UID);
    const infos = await findMany(infoQuery, { user: user.id }, trx);
    if (infos.length > 1) throw new MigrationInputError("USER_INFO_AMBIGUOUS", 409);
    const firstName = optionalText(sourceProfile.firstName, 255);
    const lastName = optionalText(sourceProfile.lastName, 255);
    const existingInfo = infos[0] || null;
    const data: Record<string, unknown> = { user: user.id };
    if (!optionalText(existingInfo?.FirstName, 255) && firstName) data.FirstName = firstName;
    if (!optionalText(existingInfo?.LastName, 255) && lastName) data.LastName = lastName;
    if (Object.keys(data).length > 1) {
      if (existingInfo) {
        await infoQuery.update({ where: { id: existingInfo.id }, data, transacting: trx } as any);
      } else {
        await infoQuery.create({ data, transacting: trx } as any);
      }
    }
  }
  await persistMapping(trx, "customer", sourceCustomerId, Number(user.id), mapped ? "source-mapping" : "legacy-source-id");
  return user;
}
