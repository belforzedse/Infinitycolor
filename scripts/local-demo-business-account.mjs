import { createRequire } from 'node:module';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

// Only the source-defined local CMS Admin/required bootstrap anchor roles are assignable here.
export function verifyBusinessRole(response, role, anchor, name) {
  const actual = anchor ? (name === 'line-harekat' ? response.user?.admin : response.admin) : response.role;
  if (anchor ? actual?.roleId !== String(role.id) || actual?.roleName !== role.name : actual?.id !== role.id || actual?.name !== role.name || actual?.type !== role.type) throw new Error('Owned business account no longer has its source-defined admin role; the existing role was preserved');
}
export async function ensureBusinessAccount(api, publicRequest, root, config, env, account, persist) {
  const anchor = ['line-harekat', 'infinity'].includes(config.name);
  if (!anchor && config.name !== 'alp') throw new Error('No business fixture role is authorized for this repo');
  const roleType = anchor ? 'superadmin' : 'admin';
  const roleName = anchor ? 'Superadmin' : 'Admin';
  const prefix = anchor ? 'local-business-admin' : 'local-editor';
  const email = `${prefix}-${config.name}@example.test`;
  if (account.email !== email || (anchor && account.phone !== config.businessAdminPhone) || typeof account.password !== 'string' || account.password.length < 12) throw new Error('Reserved synthetic business identity is required');
  const require = createRequire(path.join(root, config.backend, 'package.json'));
  let bcrypt;
  try { bcrypt = require('bcryptjs'); }
  catch { bcrypt = createRequire(require.resolve('@strapi/plugin-users-permissions/strapi-server'))('bcryptjs'); }
  let Client;
  try { ({ Client } = require('pg')); }
  catch { ({ Client } = createRequire(require.resolve('@strapi/database'))('pg')); }
  const installed = JSON.parse(await readFile(path.join(root, config.backend, 'node_modules/@strapi/strapi/package.json'), 'utf8'));
  if (Number(installed.version.split('.')[0]) !== config.strapiMajor) throw new Error('The fixture API/password contract does not match the installed Strapi major');
  if (anchor) {
    const schema = JSON.parse(await readFile(path.join(root, config.backend, 'src/extensions/users-permissions/content-types/user/schema.json'), 'utf8'));
    if (schema.attributes?.password?.type !== 'string') throw new Error('Reviewed anchor password string schema is required');
  }
  const table = anchor ? 'users' : 'up_users';
  const client = new Client({ host: '127.0.0.1', port: Number(env.get('DATABASE_PORT')), database: env.get('DATABASE_NAME'), user: env.get('DATABASE_USERNAME'), password: env.get('DATABASE_PASSWORD'), ssl: false, connectionTimeoutMillis: 1500, query_timeout: 2000, statement_timeout: 2000, options: '-c default_transaction_read_only=on' });
  client.on('error', () => {});
  try {
    await client.connect();
    const roleData = await api('/users-permissions/roles');
    const roles = (roleData.roles ?? roleData.data?.roles ?? []).filter((role) => role.type === roleType && role.name === roleName);
    if (roles.length !== 1) throw new Error('Exactly one existing source-defined business role is required; no role or permission was changed');
    const existing = anchor
      ? await client.query('SELECT id,email,phone,password,blocked,confirmed FROM public.users WHERE email=$1 OR phone IN ($2,$3)', [email, account.phone, '0' + account.phone.slice(3)])
      : await client.query('SELECT id,email,password,blocked,confirmed FROM public.up_users WHERE email=$1 OR username=$1', [email]);
    if (existing.rows.length) {
      const row = existing.rows[0];
      if (existing.rows.length !== 1 || !account.id || row.id !== account.id || row.email !== email || (anchor && row.phone !== account.phone)) throw new Error('Reserved business account collision or missing ownership; no existing user or role was changed');
    } else {
      if (account.id) throw new Error('Owned business account was removed; no replacement was silently created');
      if (anchor) {
        const total = await client.query('SELECT count(*)::int AS total FROM public.users');
        if (total.rows[0]?.total !== 0) throw new Error('A new business safety anchor is allowed only in the first empty local business store; existing store was kept');
      }
      // Stock Strapi5 password fields hash in Document Service; custom v4 string fields need one explicit cost10 hash.
      const password = anchor ? await bcrypt.hash(account.password, 10) : account.password;
      const body = { username: anchor ? account.phone : email, email, password, provider: 'local', confirmed: true, blocked: false, role: roles[0].id, ...(anchor ? { phone: account.phone, IsActive: true, IsVerified: true, ProfileCompletedAt: new Date().toISOString() } : {}) };
      const created = await api('/content-manager/collection-types/plugin::users-permissions.user', { method: 'POST', body });
      const user = created.data ?? created;
      if (!Number.isSafeInteger(user.id)) throw new Error('Business account creation returned an unexpected identity');
      account.id = user.id; await persist();
    }
    const proof = await client.query(`SELECT id,password,blocked,confirmed FROM public.${table} WHERE id=$1`, [account.id]);
    const stored = proof.rows[0];
    if (!stored || !/^\$2[aby]\$10\$/.test(stored.password ?? '') || !await bcrypt.compare(account.password, stored.password) || stored.blocked || !stored.confirmed) throw new Error('Business account hash/active state failed verification; no password or account state was reset');
    if (anchor) {
      const profiles = await api(`/content-manager/collection-types/api::local-user-info.local-user-info?filters[user][id][$eq]=${account.id}&pageSize=10`);
      if ((profiles.results ?? []).length > 1) throw new Error('Business profile relation is ambiguous');
      if (!(profiles.results ?? []).length) await api('/content-manager/collection-types/api::local-user-info.local-user-info', { method: 'POST', body: { FirstName: 'مدیر', LastName: 'نمونهٔ محلی', Bio: 'local-demo-business-admin', user: account.id } });
      const { createBridgeHeaders } = require('@repo/auth-core/bridge-signature');
      const route = config.name === 'line-harekat' ? '/api/internal/auth/session/password' : '/api/internal/auth/password/verify';
      const body = { phone: account.phone, password: account.password, ...(config.name === 'line-harekat' ? { audience: 'admin' } : {}) };
      const secret = env.get(config.name === 'line-harekat' ? 'LHC_INTERNAL_AUTH_SECRET' : 'AUTH_STRAPI_BRIDGE_SECRET');
      if (!secret || secret.length < 32) throw new Error('Local internal-auth bridge is required');
      const signed = createBridgeHeaders(secret, 'POST', route, body);
      const response = await publicRequest(route, { method: 'POST', body, extraHeaders: signed.headers });
      if ((config.name === 'line-harekat' ? response.user?.id : response.strapiUserId) !== account.id) throw new Error('Owned business account did not pass the real local password boundary');
      verifyBusinessRole(response, roles[0], true, config.name);
      if (config.name === 'line-harekat') {
        const revokeRoute = '/api/internal/auth/session/revoke';
        const revokeBody = { sessionToken: response.sessionToken, csrfToken: response.csrfToken, audience: 'admin' };
        const revoke = createBridgeHeaders(secret, 'POST', revokeRoute, revokeBody);
        await publicRequest(revokeRoute, { method: 'POST', body: revokeBody, extraHeaders: revoke.headers });
      }
    } else {
      const login = await publicRequest('/api/auth/local', { method: 'POST', body: { identifier: email, password: account.password } });
      if (login.user?.id !== account.id || typeof login.jwt !== 'string') throw new Error('Local CMS Admin password login did not verify');
      const profile = await publicRequest('/api/users/me?populate=role', { token: login.jwt });
      verifyBusinessRole(profile, roles[0], false, config.name);
    }
    account.verified = true; await persist();
  } finally { await client.end().catch(() => {}); }
}
