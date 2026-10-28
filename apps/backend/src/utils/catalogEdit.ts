import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { apiTokenCredentials, resolveAdminActor, type AdminActor } from "./adminAuthorization";
import { resolveUserFullName } from "./userDisplayName";
import { writeAuditEvent } from "../audit/writer";
import { hasCapability } from "@repo/auth-core";

export class CatalogEditError extends Error {
  constructor(public code: string, public status = 409, public details: Record<string, unknown> = {}) {
    super(code);
    this.name = "CatalogEditError";
  }
}

export type EditProof = { token: string; instanceId: string; generation: number; expectedRevision?: number };
export type StaffEditor = { actor: AdminActor; sessionId: string };
type Writer =
  | { kind: "human"; editor: StaffEditor; proof: EditProof }
  | { kind: "transient"; editor: StaffEditor; command?: "catalog-lifecycle" }
  | { kind: "system"; command: "publication" | "scheduled-publication" | "catalog-import" | "catalog-lifecycle" | "catalog-initialization" | "category-reassignment" | "fixture" };
type MutationContext = {
  ids: number[]; trx: any; writer: Writer; revisions: Map<number, number>; effects: Array<() => Promise<unknown>>;
  colorGalleriesBefore?: Map<number, any[]>;
};
const mutationStorage = new AsyncLocalStorage<MutationContext>();
const homepageWriteStorage = new AsyncLocalStorage<boolean>();

export const homepageSettingsWriteActive = () => homepageWriteStorage.getStore() === true;
export const withHomepageSettingsWrite = <T>(write: () => Promise<T>): Promise<T> => homepageWriteStorage.run(true, write);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const iso = (value: any) => value ? new Date(value).toISOString() : null;
const integer = (value: unknown) => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null;

export function editLeaseConfig() {
  const value = (key: string, fallback: number, min: number, max: number) => {
    const parsed = Number(process.env[key]);
    return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
  };
  const leaseSeconds = value("PRODUCT_EDIT_LEASE_SECONDS", 90, 30, 600);
  return {
    leaseSeconds,
    heartbeatSeconds: Math.min(value("PRODUCT_EDIT_HEARTBEAT_SECONDS", 30, 5, 120), Math.floor(leaseSeconds / 3)),
    pollSeconds: value("PRODUCT_EDIT_POLL_SECONDS", 10, 5, 60),
  };
}

function header(ctx: any, name: string): string {
  return String(ctx.get?.(name) || ctx.request?.headers?.[name.toLowerCase()] || "");
}

export function parseEditProof(ctx: any, requireRevision = true): EditProof {
  const token = header(ctx, "X-Product-Edit-Token");
  const instanceId = header(ctx, "X-Product-Edit-Instance");
  const generation = integer(header(ctx, "X-Product-Edit-Generation"));
  const expectedRevision = integer(header(ctx, "X-Product-Expected-Revision"));
  if (!TOKEN.test(token) || !UUID.test(instanceId) || generation === null || generation < 1 || (requireRevision && expectedRevision === null)) {
    throw new CatalogEditError("EDIT_LEASE_LOST");
  }
  return { token, instanceId, generation, ...(expectedRevision === null ? {} : { expectedRevision }) };
}

export async function staffEditor(ctx: any, strapi: any): Promise<StaffEditor> {
  const sessionId = ctx.state?.betterAuthSessionId;
  const actor = await resolveAdminActor(strapi, ctx.state?.user);
  if (!actor || typeof sessionId !== "string" || !sessionId || sessionId.length > 128) {
    throw new CatalogEditError("AUTHENTICATED_STAFF_SESSION_REQUIRED", 401);
  }
  return { actor, sessionId };
}

async function refreshEditor(strapi: any, editor: StaffEditor, requireProductUpdate: boolean, takeover = false): Promise<void> {
  const actor = await resolveAdminActor(strapi, editor.actor.user);
  if (!actor || (requireProductUpdate && !hasCapability(actor.role, "product.update"))) {
    throw new CatalogEditError(takeover ? "EDIT_TAKEOVER_FORBIDDEN" : "PRODUCT_EDIT_FORBIDDEN", 403);
  }
  editor.actor = actor;
}

async function databaseNow(trx: any): Promise<Date> {
  const result = await trx.raw("SELECT clock_timestamp() AS now");
  return new Date(result.rows[0].now);
}

async function lockProduct(trx: any, id: number, allowPurged = false): Promise<any> {
  if (!Number.isSafeInteger(id) || id < 1) throw new CatalogEditError("PRODUCT_ID_INVALID", 400);
  const row = await trx("products").where({ id }).forUpdate().first();
  if (!row || (row.purged_at && !allowPurged)) throw new CatalogEditError("PRODUCT_NOT_FOUND", 404);
  return row;
}

async function leaseRow(trx: any, id: number): Promise<any> {
  await trx("product_edit_leases").insert({ product_id: id }).onConflict("product_id").ignore();
  return trx("product_edit_leases").where({ product_id: id }).forUpdate().first();
}

function active(row: any, now: Date): boolean {
  return Boolean(row?.owner_id && row.token_hash && row.expires_at && new Date(row.expires_at) > now);
}

function own(row: any, editor: StaffEditor, proof: EditProof): boolean {
  if (!row || Number(row.owner_id) !== Number(editor.actor.user.id) || row.session_id !== editor.sessionId || row.editor_instance_id !== proof.instanceId || Number(row.generation) !== proof.generation) return false;
  const expected = Buffer.from(hash(proof.token), "hex");
  const stored = Buffer.from(String(row.token_hash || ""), "hex");
  return stored.length === expected.length && timingSafeEqual(stored, expected);
}

function presence(row: any, now: Date, editor?: StaffEditor, proof?: EditProof) {
  const isActive = active(row, now);
  return {
    owner: isActive ? { id: Number(row.owner_id), label: row.owner_label || "کاربر دیگری" } : null,
    generation: Number(row?.generation || 0),
    expiresAt: isActive ? iso(row.expires_at) : null,
    serverNow: now.toISOString(),
    owned: Boolean(isActive && editor && proof && own(row, editor, proof)),
    ...editLeaseConfig(),
  };
}

function validateLease(row: any, now: Date, editor: StaffEditor, proof: EditProof): void {
  if (!active(row, now) || !own(row, editor, proof)) {
    throw new CatalogEditError("EDIT_LEASE_LOST", 409, { current: presence(row, now) });
  }
}

async function leaseAudit(strapi: any, trx: any, editor: StaffEditor, productId: number, eventKey: string, previousOwner?: number) {
  await writeAuditEvent(strapi, {
    eventKey,
    initiator: { type: "human", id: editor.actor.user.id, label: resolveUserFullName(editor.actor.user) || editor.actor.user.username, role: editor.actor.role },
    actor: { type: "human", id: editor.actor.user.id, role: editor.actor.role },
    origin: "admin_ui", target: { type: "product", id: productId },
    metadata: previousOwner ? { previousEditorId: previousOwner, newEditorId: editor.actor.user.id } : undefined,
  }, { trx });
}

export async function readEditPresence(strapi: any, productId: number, editor: StaffEditor, proof?: EditProof) {
  return strapi.db.transaction(async ({ trx }: any) => {
    const row = await trx("product_edit_leases").where({ product_id: productId }).first();
    const product = await trx("products").where({ id: productId }).select("id", "purged_at").first();
    if (!product || product.purged_at) throw new CatalogEditError("PRODUCT_NOT_FOUND", 404);
    return presence(row, await databaseNow(trx), editor, proof);
  });
}

export async function changeEditLease(strapi: any, productId: number, editor: StaffEditor, action: string, input: any, proof?: EditProof, snapshot?: () => Promise<unknown>) {
  return strapi.db.transaction(async ({ trx }: any) => {
    await lockProduct(trx, productId);
    await refreshEditor(strapi, editor, true, action === "takeover");
    const row = await leaseRow(trx, productId);
    const now = await databaseNow(trx);
    const current = presence(row, now);
    if (action === "renew" || action === "release") {
      if (!proof) throw new CatalogEditError("EDIT_LEASE_LOST");
      validateLease(row, now, editor, proof);
      if (action === "release") {
        await trx("product_edit_leases").where({ product_id: productId }).update({ owner_id: null, owner_label: null, session_id: null, editor_instance_id: null, token_hash: null, expires_at: null });
        return { released: true };
      }
      const expiresAt = new Date(now.getTime() + editLeaseConfig().leaseSeconds * 1000);
      await trx("product_edit_leases").where({ product_id: productId }).update({ expires_at: expiresAt });
      return { lease: { generation: Number(row.generation), editorInstanceId: row.editor_instance_id, expiresAt: expiresAt.toISOString(), serverNow: now.toISOString() } };
    }
    const instance = input?.editorInstanceId;
    if (!UUID.test(String(instance || ""))) throw new CatalogEditError("EDITOR_INSTANCE_INVALID", 400);
    if (action === "acquire" && active(row, now)) throw new CatalogEditError("EDIT_LEASE_CONFLICT", 409, { current });
    if (action === "takeover" && integer(input?.expectedGeneration) !== Number(row.generation)) {
      throw new CatalogEditError("EDIT_LEASE_CONFLICT", 409, { current });
    }
    if (action !== "acquire" && action !== "takeover") throw new CatalogEditError("EDIT_LEASE_ACTION_INVALID", 400);
    const token = randomBytes(32).toString("base64url");
    const generation = Number(row.generation) + 1;
    const expiresAt = new Date(now.getTime() + editLeaseConfig().leaseSeconds * 1000);
    await trx("product_edit_leases").where({ product_id: productId }).update({
      generation, owner_id: Number(editor.actor.user.id), owner_label: resolveUserFullName(editor.actor.user) || editor.actor.user.username || "کاربر",
      session_id: editor.sessionId, editor_instance_id: instance, token_hash: hash(token), acquired_at: now, expires_at: expiresAt,
    });
    await leaseAudit(strapi, trx, editor, productId, action === "takeover" ? "products.edit_taken_over" : "products.edit_acquired", action === "takeover" ? Number(row.owner_id) : undefined);
    return {
      lease: { token, generation, editorInstanceId: instance, expiresAt: expiresAt.toISOString(), serverNow: now.toISOString(), ...editLeaseConfig() },
      snapshot: snapshot ? await snapshot() : undefined,
    };
  });
}

export function catalogMutationContext(): MutationContext | undefined { return mutationStorage.getStore(); }

export async function afterCatalogCommit(strapi: any, effect: () => Promise<unknown>): Promise<void> {
  const context = catalogMutationContext();
  if (context) { context.effects.push(effect); return; }
  if (strapi.db?.inTransaction?.()) {
    await strapi.db.transaction(async ({ onCommit }: any) => {
      onCommit(() => { void effect().catch((error: Error) => strapi.log.error("Catalog post-commit effect failed", { name: error.name })); });
    });
    return;
  }
  await effect();
}

export async function runCatalogMutation<T>(strapi: any, ids: number[], writer: Writer, callback: (trx: any) => Promise<T>, finalize?: (trx: any) => Promise<void>): Promise<{ value: T; revisions: Map<number, number> }> {
  const productIds = [...new Set(ids)].sort((a, b) => a - b);
  if (!productIds.length) throw new CatalogEditError("PRODUCT_ID_INVALID", 400);
  const outer = catalogMutationContext();
  if (outer) {
    if (productIds.some((id) => !outer.ids.includes(id))) throw new CatalogEditError("CATALOG_LOCK_ORDER_INVALID", 500);
    return { value: await callback(outer.trx), revisions: outer.revisions };
  }
  const enclosingTransaction = Boolean(strapi.db.inTransaction?.());
  let context: MutationContext;
  const value = await strapi.db.transaction(async ({ trx }: any) => {
    const rows = new Map<number, any>();
    // Lifecycle commands must reach the transition matrix for tombstones:
    // repeated purge is a no-op, while restore reports PRODUCT_PURGED.
    const allowPurged = writer.kind !== "human" && writer.command === "catalog-lifecycle";
    for (const id of productIds) rows.set(id, await lockProduct(trx, id, allowPurged));
    if (writer.kind !== "system") await refreshEditor(strapi, writer.editor, writer.kind === "human");
    for (const id of productIds) {
      const row = await leaseRow(trx, id);
      const now = await databaseNow(trx);
      if (writer.kind === "human") {
        validateLease(row, now, writer.editor, writer.proof);
        if (writer.proof.expectedRevision !== Number(rows.get(id).edit_revision || 0)) {
          throw new CatalogEditError("PRODUCT_VERSION_CONFLICT", 409, { currentRevision: Number(rows.get(id).edit_revision || 0) });
        }
      } else if (writer.kind === "transient") {
        if (active(row, now)) throw new CatalogEditError("EDIT_LEASE_CONFLICT", 409, { current: presence(row, now) });
        // Parent lock owns this short operation; advance its fence without a
        // browser credential. An expired session cannot renew or release it.
        await trx("product_edit_leases").where({ product_id: id }).update({ generation: Number(row.generation) + 1, owner_id: null, token_hash: null, session_id: null, editor_instance_id: null, owner_label: null, acquired_at: now, expires_at: null });
      }
    }
    context = { ids: productIds, trx, writer, revisions: new Map(), effects: [] };
    return mutationStorage.run(context, async () => {
      const result = await callback(trx);
      const noCatalogChange = (writer.kind === "system" || (writer.kind === "transient" && writer.command === "catalog-lifecycle")) && result && typeof result === "object" && ((result as any).changed === false || ["stale", "not-due"].includes((result as any).outcome));
      for (const id of productIds) {
        const nextRevision = Number(rows.get(id).edit_revision || 0) + (noCatalogChange ? 0 : 1);
        if (!noCatalogChange) await trx("products").where({ id }).update({ edit_revision: nextRevision });
        context.revisions.set(id, nextRevision);
        if (writer.kind !== "system" && !noCatalogChange) await leaseAudit(strapi, trx, writer.editor, id, "products.edit_committed");
      }
      if (finalize) await finalize(trx);
      return result;
    });
  });
  if (enclosingTransaction && context!.effects.length) {
    const effects = context!.effects.splice(0);
    await strapi.db.transaction(async ({ onCommit }: any) => {
      onCommit(() => { for (const effect of effects) void effect().catch((error: Error) => strapi.log.error("Catalog post-commit effect failed", { name: error.name })); });
    });
  }
  for (const effect of context!.effects) {
    try { await effect(); } catch (error) { strapi.log.error("Catalog post-commit effect failed", { name: error instanceof Error ? error.name : "Unknown" }); }
  }
  return { value, revisions: context!.revisions };
}

export async function runCatalogSystemMutation<T>(strapi: any, productIds: number[], command: Extract<Writer, { kind: "system" }>["command"], callback: (trx: any) => Promise<T>): Promise<T> {
  return (await runCatalogMutation(strapi, productIds, { kind: "system", command }, callback)).value;
}

/** Internal command adapters are explicit; a missing HTTP proof is never a job. */
export async function coordinateCatalogCommand<T>(strapi: any, productId: number, origin: string, command: Extract<Writer, { kind: "system" }>["command"], callback: () => Promise<T>): Promise<T> {
  const context = catalogMutationContext();
  if (context) {
    if (!context.ids.includes(productId)) throw new CatalogEditError("CATALOG_LOCK_ORDER_INVALID", 500);
    return callback();
  }
  const request = strapi.requestContext?.get?.();
  if (origin === "admin" && request) {
    // The entry controller has already validated the token's capability.
    // Service credentials have no human session or browser edit lease.
    if (apiTokenCredentials(request)) return runCatalogSystemMutation(strapi, [productId], command, callback);
    const editor = await staffEditor(request, strapi);
    return (await runCatalogMutation(strapi, [productId], { kind: "transient", editor, ...(command === "catalog-lifecycle" ? { command } : {}) }, callback)).value;
  }
  return runCatalogSystemMutation(strapi, [productId], command, callback);
}

export function sendCatalogEditError(ctx: any, error: unknown): void {
  if (!(error instanceof CatalogEditError)) throw error;
  ctx.status = error.status;
  ctx.body = { error: { status: error.status, name: error.name, message: error.code, details: { code: error.code, ...error.details } } };
  ctx.set?.("Cache-Control", "private, no-store");
}

export async function rejectCatalogMutationAudit(strapi: any, editor: StaffEditor | undefined, ids: number[], error: CatalogEditError) {
  if (!editor) return;
  try {
    await writeAuditEvent(strapi, {
      eventKey: "products.edit_rejected", result: "denied",
      initiator: { type: "human", id: editor.actor.user.id, role: editor.actor.role },
      actor: { type: "human", id: editor.actor.user.id, role: editor.actor.role },
      origin: "admin_ui", target: { type: "product", id: ids[0] },
      reasonCode: error.code,
    });
  } catch { strapi.log.error("Catalog rejected mutation audit unavailable", { code: error.code }); }
}
