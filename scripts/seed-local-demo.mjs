#!/usr/bin/env node
import { ensureBusinessAccount } from './local-demo-business-account.mjs';
// Synthetic local content through authenticated Strapi admin interfaces.
import { readFile, writeFile, mkdir, rm, realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureCustomer } from './local-demo-customer.mjs';
import { parseEnv, validateEnv, portOpen } from './dev-doctor.mjs';
import { verifySqlitePath, requireListenerOwnershipPlatform, captureOwnedProcess, verifyOwnedListener, ownedGroupAlive, openOwnedConnection } from './local-demo-process.mjs';

export function guardTarget(env, config, ambient = process.env) {
  const errors = validateEnv(env, config.rules);
  if (/prod|staging/i.test(ambient.NODE_ENV ?? '')) errors.push('Ambient NODE_ENV is not local');
  for (const key of ['DATABASE_URL', 'DATABASE_HOST', 'DATABASE_NAME', 'DATABASE_PORT', 'DATABASE_CLIENT', 'DATABASE_USERNAME', 'DATABASE_PASSWORD', 'DATABASE_SCHEMA', 'DATABASE_FILENAME']) {
    if (ambient[key] !== undefined && ambient[key] !== env.get(key)) errors.push(`Ambient ${key} differs from the local file`);
  }
  if (config.sqlite && env.get('DATABASE_URL')) errors.push('SQLite fixture refuses every DATABASE_URL override');
  if (!config.sqlite && (env.get('DATABASE_CLIENT') !== 'postgres' || !env.get('DATABASE_USERNAME') || !env.get('DATABASE_PASSWORD'))) errors.push('Local PostgreSQL client/user/password are required');
  // Seeder safety is enforced here independently of the read-only doctor.
  if (config.sqlite) {
    if (env.get('DATABASE_URL') || !/^\.tmp\/[a-zA-Z0-9_-]+\.db$/.test(env.get('DATABASE_FILENAME') ?? '.tmp/data.db')) errors.push('Only this repo’s .tmp local SQLite file is allowed');
  } else {
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(env.get('DATABASE_HOST')) || !new RegExp(`^${config.rules.database}(?:_(?:test|e2e)[a-z0-9_]*)?$`).test(env.get('DATABASE_NAME') ?? '') || env.get('DATABASE_USERNAME') !== config.databaseUsername || !/^\d+$/.test(env.get('DATABASE_PORT') ?? '') || Number(env.get('DATABASE_PORT')) < 1 || Number(env.get('DATABASE_PORT')) > 65535 || env.get('DATABASE_SSL') === 'true' || (env.get('DATABASE_SCHEMA') && env.get('DATABASE_SCHEMA') !== 'public')) errors.push('Explicit repository-local PostgreSQL name/user/port/public schema without SSL are required');
    if (env.get('DATABASE_URL')) {
      try {
        const url = new URL(env.get('DATABASE_URL'));
        if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.search || url.hash || decodeURIComponent(url.pathname.slice(1)) !== env.get('DATABASE_NAME') || Number(url.port || 5432) !== Number(env.get('DATABASE_PORT')) || decodeURIComponent(url.username) !== env.get('DATABASE_USERNAME') || decodeURIComponent(url.password) !== env.get('DATABASE_PASSWORD')) errors.push('Effective DATABASE_URL does not exactly match the explicit local database credentials');
      } catch { errors.push('Effective DATABASE_URL is invalid'); }
    }
  }
  const port = Number(env.get('PORT') ?? 1337);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) errors.push('PORT must be an unprivileged local port');
  if (config.sqlite && (env.get('DATABASE_CLIENT') && env.get('DATABASE_CLIENT') !== 'sqlite')) errors.push('This fixture requires the local SQLite backend');
  if (errors.length) throw new Error(errors.join('; '));
  return port;
}
export function requestLocal(port, route, { method = 'GET', token, body, contentType, extraHeaders = {}, deadlineMs = 10000, verifiedSocket } = {}) {
  if (!route.startsWith('/') || route.startsWith('//')) throw new Error('Local relative route required');
  return new Promise((resolve, reject) => {
    let settled = false; let deadline; let req;
    const agent = verifiedSocket ? new http.Agent({ keepAlive: false }) : undefined;
    if (agent) agent.createConnection = () => verifiedSocket;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(deadline); agent?.destroy();
      if (error) { reject(error); req?.destroy(); } else resolve(value);
    };
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    req = http.request({ hostname: '127.0.0.1', port, path: route, method, timeout: 8000, ...(agent ? { agent } : {}),
      headers: { ...extraHeaders, Host: `localhost:${port}`, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(payload ? { 'Content-Type': contentType ?? 'application/json', 'Content-Length': payload.length } : {}) } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; if (text.length > 4 * 1024 * 1024) finish(new Error('Local API response too large')); });
      res.once('aborted', () => finish(new Error('Local API response interrupted')));
      res.once('error', () => finish(new Error('Local API response interrupted')));
      res.once('close', () => { if (!res.complete) finish(new Error('Local API response interrupted')); });
      res.once('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) { finish(new Error(`Local request ${method} ${route.split('?')[0]} failed (HTTP ${res.statusCode}); no response body logged`)); return; }
        try { finish(null, text ? JSON.parse(text) : {}); } catch { finish(new Error('Local API returned invalid JSON')); }
      });
    });
    deadline = setTimeout(() => finish(new Error('Local API total deadline exceeded')), deadlineMs);
    req.once('timeout', () => finish(new Error('Local API timeout')));
    req.once('error', () => finish(new Error('Local API unavailable')));
    req.end(payload);
  });
}
export async function ensureEntry(api, uid, key, value, data, { publish = false, ownerField = key, relations = {} } = {}) {
  const route = `/content-manager/collection-types/${uid}`;
  const populate = Object.keys(relations).map((field) => `&populate[${field}]=true`).join('');
  const found = await api(`${route}?filters[${key}][$eq]=${encodeURIComponent(value)}&pageSize=10${populate}`);
  const rows = found.results ?? found.data?.results ?? [];
  if (rows.length > 1) throw new Error(`Duplicate local fixture key in ${uid}; inspect it before retrying`);
  if (rows.length === 1) {
    const row = rows[0];
    if (row[ownerField] !== data[ownerField]) throw new Error(`Reserved fixture key collision in ${uid}; existing content was kept`);
    for (const [field, expected] of Object.entries(relations)) if (relationReference(row[field]) !== expected) throw new Error(`Reserved fixture relation collision in ${uid}; existing content was kept`);
    if (publish && !row.publishedAt) await api(`${route}/${row.documentId ?? row.id}/actions/publish`, { method: 'POST', body: {} });
    return { row, created: false };
  }
  const created = await api(route, { method: 'POST', body: data });
  const row = created.data ?? created;
  if (!row.id) throw new Error(`Unexpected create result for ${uid}`);
  if (publish) await api(`${route}/${row.documentId ?? row.id}/actions/publish`, { method: 'POST', body: {} });
  return { row, created: true };
}
function relationReference(value) { const item = value?.data ?? value; return typeof item === 'object' && item ? item.documentId ?? item.id : item; }
export async function seedContent(api, config, image) {
  const summary = [];
  const ensure = async (uid, key, value, data, opts) => {
    const result = await ensureEntry(api, uid, key, value, data, opts);
    summary.push({ uid, created: result.created }); return result.row;
  };
  if (config.kind === 'commerce') {
    // Read the reserved SKU and its canonical parent/stock before creating anything.
    const variations = await api('/content-manager/collection-types/api::product-variation.product-variation?filters[SKU][$eq]=LOCAL-DEMO-001&pageSize=10&populate[product]=true&populate[product_stock]=true');
    const existingVariations = variations.results ?? variations.data?.results ?? [];
    if (existingVariations.length > 1) throw new Error('Duplicate reserved local SKU; no content was changed');
    if (existingVariations.length) {
      const products = await api('/content-manager/collection-types/api::product.product?filters[Slug][$eq]=local-demo-product&pageSize=10');
      const stocks = await api('/content-manager/collection-types/api::product-stock.product-stock?filters[external_id][$eq]=local-demo-stock-001&pageSize=10');
      const productRows = products.results ?? products.data?.results ?? [];
      const stockRows = stocks.results ?? stocks.data?.results ?? [];
      if (productRows.length !== 1 || stockRows.length !== 1 || productRows[0].Title !== config.productTitle || stockRows[0].external_source !== 'local-demo' || relationReference(existingVariations[0].product) !== relationReference(productRows[0]) || relationReference(existingVariations[0].product_stock) !== relationReference(stockRows[0])) throw new Error('Reserved local SKU belongs to a foreign or missing product/stock; no content was changed');
    }
    const category = await ensure('api::product-category.product-category', 'Slug', 'local-demo-catalog', { Title: 'نمونهٔ محلی', Slug: 'local-demo-catalog', isMainCategory: true, featured: true, Color: '#356859', Image: image }, { ownerField: 'Title' });
    const product = await ensure('api::product.product', 'Slug', 'local-demo-product', { Title: config.productTitle, Slug: 'local-demo-product', Status: 'Active', ProductType: 'Simple', IsSimpleProduct: true, Weight: 100, Description: 'محصول ساختگی برای تمرین روی دیتابیس محلی.', CoverImage: image, product_main_category: (category.documentId ?? category.id) }, { ownerField: 'Title' });
    const stock = await ensure('api::product-stock.product-stock', 'external_id', 'local-demo-stock-001', { Count: 12, reservedCount: 0, external_id: 'local-demo-stock-001', external_source: 'local-demo' }, { ownerField: 'external_source' });
    await ensure('api::product-variation.product-variation', 'SKU', 'LOCAL-DEMO-001', { SKU: 'LOCAL-DEMO-001', Price: '250000', IsPublished: true, product: (product.documentId ?? product.id), product_stock: (stock.documentId ?? stock.id) }, { relations: { product: product.documentId ?? product.id, product_stock: stock.documentId ?? stock.id } });
  } else if (config.kind === 'agency') {
    const author = await ensure('api::article-author.article-author', 'slug', 'local-demo-author', { displayName: 'نویسندهٔ نمونهٔ محلی', slug: 'local-demo-author', bio: 'پروفایل ساختگی توسعه.' }, { ownerField: 'displayName' });
    const category = await ensure('api::article-category.article-category', 'slug', 'local-demo-category', { name: 'نمونهٔ محلی', slug: 'local-demo-category', description: 'مطالب تمرینی محلی' }, { ownerField: 'name' });
    await ensure('api::article.article', 'slug', 'local-demo-article', { title: 'مقالهٔ نمونهٔ محلی', slug: 'local-demo-article', excerpt: 'یک مقالهٔ کوتاه برای تمرین روی ریپو.', bodyHtml: '<p>این مقاله فقط برای دیتابیس محلی نوشته شده است.</p>', featuredImage: image, featuredImageAlt: 'تصویر نمونهٔ محلی', documentDirection: 'rtl', author: (author.documentId ?? author.id), categories: [(category.documentId ?? category.id)] }, { publish: true, ownerField: 'title' });
    await ensure('api::service.service', 'slug', 'local-demo-service', { name: 'خدمت نمونهٔ محلی', slug: 'local-demo-service', shortDescription: 'خدمت ساختگی برای تمرین', description: 'نمونهٔ محلی توسعه', accentColor: '#356859', image, hasPage: false, order: 999 }, { publish: true, ownerField: 'name' });
  } else if (config.kind === 'support') {
    await ensure('api::support-report.support-report', 'title', 'گزارش نمونهٔ محلی', { name: 'کاربر ساختگی', phone: '09000000001', title: 'گزارش نمونهٔ محلی', description: 'گزارش ساختگی برای تست فرم و مدیریت وضعیت؛ اطلاعات مشتری نیست.', statuss: 'pending', attachments: [image] }, { ownerField: 'description' });
  }
  return summary;
}
export function childEnvironment(env, port, ambient = process.env) {
  const base = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA']) if (ambient[key]) base[key] = ambient[key];
  return { ...base, ...Object.fromEntries(env), NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port), STRAPI_TELEMETRY_DISABLED: 'true', STRAPI_DISABLE_UPDATE_NOTIFICATION: 'true', BROWSER: 'none' };
}
export async function startOwnedBackend(root, config, env, { onCancel = async () => {} } = {}) {
  await requireListenerOwnershipPlatform();
  await verifySqlitePath(root, config, env);
  const normalPort = Number(env.get('PORT') ?? 1337);
  if (await portOpen(normalPort)) throw new Error('Stop this repo’s backend before seeding; the configured backend port must be free');
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const cwd = path.join(root, config.backend);
  const backendRoot = await realpath(cwd);
  const publicPath = path.join(cwd, 'public');
  const publicRoot = await realpath(publicPath).catch((error) => { if (error.code !== 'ENOENT') throw error; return publicPath; });
  if (!publicRoot.startsWith(backendRoot + path.sep)) throw new Error('Local upload path resolves outside the owned backend');
  await mkdir(path.join(publicPath, 'uploads'), { recursive: true });
  const uploadRoot = await realpath(path.join(publicPath, 'uploads'));
  if (!uploadRoot.startsWith(backendRoot + path.sep)) throw new Error('Local uploads resolve outside the owned backend');
  const child = spawn(process.execPath, [path.join(cwd, 'node_modules/@strapi/strapi/bin/strapi.js'), ...(config.backendArgs ?? ['develop'])], { cwd, env: childEnvironment(env, port), stdio: 'ignore', detached: true });
  let exited = false; let cancelled = false; let stopRequested = false; let identity; let stopping;
  child.once('exit', () => { exited = true; }); child.once('error', () => { exited = true; });
  const alive = () => !stopRequested && !cancelled && !exited && child.exitCode === null;
  const stop = () => {
    // Invalidate the request lifecycle before OS teardown or Node exit delivery.
    stopRequested = true;
    if (stopping) return stopping;
    stopping = (async () => {
      const group = identity ?? { pid: child.pid, group: child.pid };
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        for (let tries = 0; tries < 40 && await ownedGroupAlive(group); tries++) await delay(100);
        if (await ownedGroupAlive(group)) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
          for (let tries = 0; tries < 40 && await ownedGroupAlive(group); tries++) await delay(100);
          if (await ownedGroupAlive(group)) throw new Error('Owned backend process group could not be stopped');
        }
      }
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
    })();
    return stopping;
  };
  const cancel = async (signal) => {
    if (cancelled) return;
    cancelled = true;
    try { await stop(); await onCancel(); }
    catch { console.error('Local cancellation cleanup failed; inspect the owned backend process group'); process.exit(1); }
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  const interrupt = () => { void cancel('SIGINT'); };
  const terminate = () => { void cancel('SIGTERM'); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  const assertListener = async () => {
    if (!alive()) throw new Error('Owned backend is stopping, stopped, exited or cancelled; no further fixture requests allowed');
    if (!await verifyOwnedListener(identity, port)) throw new Error('Owned backend listener disappeared; no HTTP request was sent');
  };
  const request = async (route, options = {}) => {
    if (!alive()) throw new Error('Owned backend is stopping, stopped, exited or cancelled; no HTTP request was sent');
    const socket = await openOwnedConnection(identity, port);
    if (!alive()) { socket.destroy(); throw new Error('Owned backend became unavailable before the verified HTTP request'); }
    const response = await requestLocal(port, route, { ...options, verifiedSocket: socket });
    await assertListener();
    return response;
  };
  try {
    identity = await captureOwnedProcess(child.pid);
    for (let tries = 0; tries < 120; tries++) {
      if (!alive()) throw new Error('Owned local backend exited; install/build its documented dependencies first. Child output is suppressed to protect credentials');
      if (await verifyOwnedListener(identity, port)) {
        const init = await request('/admin/init');
        await assertListener();
        if (typeof init.data?.hasAdmin === 'boolean') return { port, alive, stop, assertListener, request };
      }
      if (tries % 15 === 0) console.log('Waiting for owned local backend startup...');
      await delay(500);
    }
    throw new Error('Owned local backend did not become ready on its exact loopback port');
  } catch (error) { await stop(); throw error; }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--apply', '--help'].includes(arg))) throw new Error('Usage: node scripts/seed-local-demo.mjs [--apply]');
  if (args.includes('--help')) { console.log('Local synthetic CMS account/content. Default is a dry-run; --apply starts and stops its own local backend; stop the normal backend first. Credentials stay in ignored .local-demo-credentials.json. Existing users/content/roles are preserved.'); return; }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const config = JSON.parse(await readFile(new URL('./local-demo.config.json', import.meta.url), 'utf8'));
  const env = parseEnv(await readFile(path.join(root, config.env), 'utf8'));
  const configuredPort = guardTarget(env, config);
  await verifySqlitePath(root, config, env);
  if (!args.includes('--apply')) { console.log(`Local target validated. Planned fixture: ${config.kind}. Run with --apply with storage running and this repo’s backend stopped on port ${configuredPort}.`); return; }
  await requireListenerOwnershipPlatform();
  const lock = path.join(root, '.local-demo.lock'); await mkdir(lock);
  let owned;
  try {
    owned = await startOwnedBackend(root, config, env, { onCancel: () => rm(lock, { recursive: true, force: true }) });
    const { port } = owned;
    const boundRequest = (route, options) => owned.request(route, options);
    const credentialFile = path.join(root, '.local-demo-credentials.json');
    const init = await boundRequest('/admin/init');
    let credentials;
    try { credentials = JSON.parse(await readFile(credentialFile, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Local demo credentials file is invalid');
      if (init.data?.hasAdmin !== false) throw new Error('This local CMS already has an admin. Create the synthetic demo admin through its Users page, then put its email/password in .local-demo-credentials.json; existing accounts were kept.');
      credentials = { email: `local-demo-${config.name}@example.test`, password: `Local-${randomBytes(24).toString('base64url')}!9` };
      await owned.assertListener(); await writeFile(credentialFile, JSON.stringify(credentials, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    if (credentials.email !== `local-demo-${config.name}@example.test` || typeof credentials.password !== 'string' || credentials.password.length < 12) throw new Error('Use this repo’s synthetic example.test demo admin; no real users can be changed');
    const auth = await boundRequest(init.data?.hasAdmin === false ? '/admin/register-admin' : '/admin/login', { method: 'POST', body: { email: credentials.email, password: credentials.password, firstname: 'Local', lastname: 'Demo' } });
    const token = auth.data?.token ?? auth.data?.accessToken;
    if (!token) throw new Error('Local technical-admin authentication failed');
    const api = (route, options = {}) => boundRequest(route, { ...options, token });
    if (!credentials.businessAdmin) { credentials.businessAdmin = { email: `${config.name === 'alp' ? 'local-editor' : 'local-business-admin'}-${config.name}@example.test`, ...(config.businessAdminPhone ? { phone: config.businessAdminPhone } : {}), password: `Business-${randomBytes(24).toString('base64url')}!9` }; await owned.assertListener(); await writeFile(credentialFile, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600 }); }
    const persistBusiness = async () => { await owned.assertListener(); return writeFile(credentialFile, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600 }); };
    await ensureBusinessAccount(api, boundRequest, root, config, env, credentials.businessAdmin, persistBusiness);
    console.log('Owned local business account hash and real password boundary verified; no existing user/role/permission was changed.');

    if (!credentials.customer) { credentials.customer = { phone: config.customerPhone, email: `local-customer-${config.name}@example.test`, password: `Customer-${randomBytes(24).toString('base64url')}!9` }; await owned.assertListener(); await writeFile(credentialFile, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600 }); }
    const persist = async () => { await owned.assertListener(); return writeFile(credentialFile, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600 }); };
    await ensureCustomer(api, boundRequest, root, config, env, credentials, persist);
    console.log('Owned local customer hash, profile and password-login boundary verified; credentials are in the private file.');
    let summary = [];
    if (config.kind !== 'account') {
    const filename = `local-demo-${config.name}.png`;
    const files = await api(`/upload/files?filters[name][$eq]=${encodeURIComponent(filename)}&pageSize=10`);
    let image = (files.results ?? files)?.[0]?.id;
    if (!image) {
      const data = await readFile(new URL('./fixtures/local-demo.png', import.meta.url));
      const boundary = 'local-demo-' + randomBytes(12).toString('hex');
      const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`)]);
      image = (await api('/upload', { method: 'POST', body, contentType: `multipart/form-data; boundary=${boundary}` }))[0]?.id;
    }
    if (!image) throw new Error('Local demo image upload failed');
    summary = await seedContent(api, config, image);
    }
    console.log(`Local demo complete: ${summary.filter((row) => row.created).length} new entries, ${summary.filter((row) => !row.created).length} kept. Credentials: .local-demo-credentials.json (open locally; do not commit).`);
    console.log('Technical Strapi /admin credentials are top-level; businessAdmin contains the local CMS Admin or commerce Superadmin account; customer (where present) contains the storefront login. Existing roles and permissions were preserved.');
  } finally { if (owned) await owned.stop(); await rm(lock, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
