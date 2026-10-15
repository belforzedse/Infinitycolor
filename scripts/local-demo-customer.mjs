import { createRequire } from 'node:module';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

// New synthetic identities only; account credentials and ownership stay in the ignored ledger.
export async function ensureCustomer(api, publicRequest, root, config, env, ledger, persist) {
  const require = createRequire(path.join(root, config.backend, 'package.json'));
  const bcrypt = require('bcryptjs');
  const { Client } = require('pg');
  const schema = JSON.parse(await readFile(path.join(root, config.backend, 'src/extensions/users-permissions/content-types/user/schema.json'), 'utf8'));
  if (schema.attributes?.password?.type !== 'string') throw new Error('This customer fixture requires the reviewed custom password string schema; automatic hashing contracts differ');
  const customer = ledger.customer;
  if (customer.phone !== config.customerPhone || customer.email !== `local-customer-${config.name}@example.test` || typeof customer.password !== 'string' || customer.password.length < 12) throw new Error('Reserved synthetic customer identity is required');
  const client = new Client({ host: '127.0.0.1', port: Number(env.get('DATABASE_PORT')), database: env.get('DATABASE_NAME'), user: env.get('DATABASE_USERNAME'), password: env.get('DATABASE_PASSWORD'), ssl: false, connectionTimeoutMillis: 1500, query_timeout: 2000, statement_timeout: 2000, options: '-c default_transaction_read_only=on' });
  client.on('error', () => {});
  try {
    await client.connect();
    const duplicate = await client.query('SELECT id, phone, email, password, blocked, confirmed FROM public.users WHERE phone IN ($1, $2) OR email=$3', [customer.phone, '0' + customer.phone.slice(3), customer.email]);
    let user;
    if (duplicate.rows.length) {
      if (duplicate.rows.length !== 1 || !customer.id || Number(duplicate.rows[0].id) !== customer.id || duplicate.rows[0].phone !== customer.phone || duplicate.rows[0].email !== customer.email) throw new Error('Reserved customer identity already exists without matching private ownership; no account was changed');
      user = duplicate.rows[0];
    } else {
      if (customer.id) throw new Error('Owned customer was removed; no replacement account was silently created');
      const roles = await api('/users-permissions/roles');
      const matches = (roles.roles ?? roles.data?.roles ?? []).filter((role) => role.type === 'customer');
      if (matches.length !== 1) throw new Error('Exactly one existing canonical customer role is required; no role or permission was changed');
      const password = await bcrypt.hash(customer.password, 10);
      const created = await api('/content-manager/collection-types/plugin::users-permissions.user', { method: 'POST', body: Object.fromEntries(Object.entries({ username: customer.phone, phone: customer.phone, email: customer.email, password, provider: 'local', confirmed: true, blocked: false, IsActive: true, IsVerified: true, role: matches[0].id, ProfileCompletedAt: new Date().toISOString() }).filter(([key]) => schema.attributes[key])) });
      user = created.data ?? created;
      if (!Number.isSafeInteger(user.id)) throw new Error('Customer creation returned an unexpected identity');
      customer.id = user.id; customer.documentId = user.documentId; await persist();
    }
    const proof = await client.query('SELECT id, password, blocked, confirmed FROM public.users WHERE id=$1', [customer.id]);
    const stored = proof.rows[0];
    if (!stored || !/^\$2[aby]\$10\$/.test(stored.password ?? '') || !await bcrypt.compare(customer.password, stored.password) || stored.blocked || !stored.confirmed) throw new Error('Owned customer password/active state did not verify; no existing account state was reset');
    const profiles = await api(`/content-manager/collection-types/api::local-user-info.local-user-info?filters[user][id][$eq]=${customer.id}&pageSize=10`);
    if ((profiles.results ?? []).length > 1) throw new Error('Customer profile relation is ambiguous');
    if (!(profiles.results ?? []).length) {
      await api('/content-manager/collection-types/api::local-user-info.local-user-info', { method: 'POST', body: { FirstName: 'کاربر', LastName: 'نمونهٔ محلی', Bio: 'local-demo-customer', user: customer.id } });
    }
    const profileLink = await client.query('SELECT count(*)::int AS total FROM public.local_user_infos_user_links WHERE user_id=$1', [customer.id]);
    if (profileLink.rows[0]?.total !== 1) throw new Error('Owned customer profile projection did not verify');
    if (config.name === 'line-harekat' || config.name === 'infinity') {
      const { createBridgeHeaders } = require('@repo/auth-core/bridge-signature');
      const route = config.name === 'line-harekat' ? '/api/internal/auth/session/password' : '/api/internal/auth/password/verify';
      const body = { phone: customer.phone, password: customer.password, ...(config.name === 'line-harekat' ? { audience: 'storefront' } : {}) };
      const secret = env.get(config.name === 'line-harekat' ? 'LHC_INTERNAL_AUTH_SECRET' : 'AUTH_STRAPI_BRIDGE_SECRET');
      if (!secret || secret.length < 32) throw new Error('Reviewed local internal-auth bridge is required');
      const signed = createBridgeHeaders(secret, 'POST', route, body);
      const response = await publicRequest(route, { method: 'POST', body, extraHeaders: signed.headers });
      if (config.name === 'line-harekat' ? response.user?.id !== customer.id || typeof response.sessionToken !== 'string' : response.strapiUserId !== customer.id) throw new Error('Real local password-session boundary did not verify the owned customer');
      if (config.name === 'line-harekat') {
        const revokeRoute = '/api/internal/auth/session/revoke';
        const revokeBody = { sessionToken: response.sessionToken, csrfToken: response.csrfToken, audience: 'storefront' };
        const revoke = createBridgeHeaders(secret, 'POST', revokeRoute, revokeBody);
        await publicRequest(revokeRoute, { method: 'POST', body: revokeBody, extraHeaders: revoke.headers });
      }
    } else {
      const login = await publicRequest('/api/auth/login-with-password', { method: 'POST', body: { phone: customer.phone, password: customer.password } });
      if (typeof login.token !== 'string' || login.token.length < 20) throw new Error('Real local password-login boundary did not verify the customer');
    }
    customer.verified = true; await persist();
    return customer.id;
  } finally { await client.end().catch(() => {}); }
}
