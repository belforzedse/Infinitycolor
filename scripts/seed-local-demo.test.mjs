import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { verifySqlitePath, ownedGroupAlive } from './local-demo-process.mjs';
import { guardTarget, childEnvironment, ensureEntry, seedContent, startOwnedBackend, requestLocal } from './seed-local-demo.mjs';
import { parseEnv } from './dev-doctor.mjs';
test('actual repo target guards reject effective remote/prod overrides and unsafe SQLite paths', async () => {
  const config = JSON.parse(await readFile(new URL('./local-demo.config.json', import.meta.url), 'utf8'));
  const example = await readFile(new URL('../' + config.env + '.example', import.meta.url), 'utf8');
  const env = parseEnv(example);
  for (const key of config.rules.required) if (/replace-|change-me|your_/.test(env.get(key) ?? '')) env.set(key, 's'.repeat(48));
  for (const key of config.rules.empty ?? []) env.set(key, '');
  assert.equal(guardTarget(env, config, {}), 1337);
  assert.throws(() => guardTarget(env, config, { NODE_ENV: 'production' }));
  assert.throws(() => guardTarget(new Map([...env, ['DATABASE_URL', 'postgresql://u:p@db.example/production']]), config, {}));
  assert.throws(() => guardTarget(env, config, { DATABASE_NAME: 'production' }));
  if (config.sqlite) assert.throws(() => guardTarget(new Map([...env, ['DATABASE_FILENAME', '/tmp/existing.db']]), config, {}));
  else {
    assert.throws(() => guardTarget(new Map([...env, ['DATABASE_USERNAME', '']]), config, {}));
    assert.throws(() => guardTarget(new Map([...env, ['DATABASE_USERNAME', 'postgres']]), config, {}));
    assert.throws(() => guardTarget(new Map([...env, ['DATABASE_SCHEMA', 'shared']]), config, {}));
    assert.throws(() => guardTarget(new Map([...env, ['DATABASE_SSL', 'true']]), config, {}));
    const exact = `postgresql://${env.get('DATABASE_USERNAME')}:${env.get('DATABASE_PASSWORD')}@127.0.0.1:${env.get('DATABASE_PORT')}/${env.get('DATABASE_NAME')}`;
    assert.equal(guardTarget(new Map([...env, ['DATABASE_URL', exact]]), config, {}), 1337);
    assert.throws(() => guardTarget(new Map([...env, ['DATABASE_URL', exact.replace(':' + env.get('DATABASE_PASSWORD') + '@', ':different-password@')]]), config, {}));
  }
  const child = childEnvironment(env, 43199, { PATH: '/bin', DATABASE_URL: 'private', NODE_OPTIONS: '--import unsafe', GOOGLE_CLIENT_SECRET: 'private' });
  assert.equal(child.NODE_ENV, 'development'); assert.equal(child.HOST, '127.0.0.1'); assert.equal(child.PORT, '43199');
  assert.equal(child.NODE_OPTIONS, undefined); assert.equal(child.GOOGLE_CLIENT_SECRET, undefined);
});
test('idempotent content fixtures preserve edited values and retry interrupted publication', async () => {
  let row; let publishes = 0; let creates = 0; let fail = true;
  const api = async (route, options = {}) => {
    if (!options.method) return { results: row ? [row] : [] };
    if (route.endsWith('/actions/publish')) { publishes++; if (fail) throw new Error('interrupted'); row.publishedAt = '2026-01-01'; return row; }
    creates++; row = { ...options.body, id: 1, documentId: 'reserved1', publishedAt: null }; return row;
  };
  const data = { slug: 'local-demo-article', title: 'Local demo', bodyHtml: '<p>Original</p>' };
  await assert.rejects(ensureEntry(api, 'api::article.article', 'slug', data.slug, data, { publish: true, ownerField: 'title' }), /interrupted/);
  row.bodyHtml = '<p>Local edit</p>'; fail = false;
  const result = await ensureEntry(api, 'api::article.article', 'slug', data.slug, data, { publish: true, ownerField: 'title' });
  assert.equal(result.created, false); assert.equal(creates, 1); assert.equal(publishes, 2); assert.equal(row.bodyHtml, '<p>Local edit</p>');
  await ensureEntry(api, 'api::article.article', 'slug', data.slug, data, { publish: true, ownerField: 'title' }); assert.equal(publishes, 2);
  row.title = 'Unrelated'; await assert.rejects(ensureEntry(api, 'api::article.article', 'slug', data.slug, data, { ownerField: 'title' }), /collision/);
});
test('commerce partial failure reuses the stable stock and does not duplicate data', async () => {
  const entries = new Map(); let next = 0; let failVariation = true;
  const api = async (route, options = {}) => {
    const base = route.split('?')[0];
    if (!options.method) return { results: entries.has(base) ? [entries.get(base)] : [] };
    if (base.includes('product-variation') && failVariation) throw new Error('interrupted variation');
    const row = { ...options.body, id: ++next, documentId: `fixture${next}` }; entries.set(base, row); return row;
  };
  await assert.rejects(seedContent(api, { kind: 'commerce', productTitle: 'Local demo' }, 1));
  const stock = entries.get('/content-manager/collection-types/api::product-stock.product-stock'); failVariation = false;
  const second = await seedContent(api, { kind: 'commerce', productTitle: 'Local demo' }, 1);
  assert.equal(second.filter((row) => row.created).length, 1); assert.equal(entries.size, 4);
  assert.equal(entries.get('/content-manager/collection-types/api::product-stock.product-stock').id, stock.id);
});
test('owned backend refuses an occupied normal port and only serves its forced loopback port', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'local-demo-child-'));
  const normal = createServer((_req, res) => res.end('{}')); await new Promise((resolve) => normal.listen(0, '127.0.0.1', resolve));
  const normalPort = normal.address().port;
  const backend = path.join(temp, 'backend'); await mkdir(path.join(backend, 'node_modules/@strapi/strapi/bin'), { recursive: true });
  await writeFile(path.join(backend, 'node_modules/@strapi/strapi/bin/strapi.js'), "require('node:http').createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:{hasAdmin:false},port:process.env.PORT,host:process.env.HOST}));}).listen(Number(process.env.PORT),process.env.HOST);\n");
  let owned;
  try {
    await assert.rejects(startOwnedBackend(temp, { backend: 'backend' }, new Map([['PORT', String(normalPort)]])), /Stop this repo/);
    await new Promise((resolve) => normal.close(resolve));
    owned = await startOwnedBackend(temp, { backend: 'backend' }, new Map([['PORT', String(normalPort)]]));
    const response = await owned.request('/admin/init');
    assert.equal(response.host, '127.0.0.1'); assert.equal(Number(response.port), owned.port); assert.notEqual(owned.port, normalPort);
    assert.equal(owned.alive(), true); await owned.stop(); assert.equal(owned.alive(), false);
    await assert.rejects(requestLocal(owned.port, '/mutation', { method: 'POST', body: {} }), /unavailable/);
  } finally { if (owned) await owned.stop(); if (normal.listening) await new Promise((resolve) => normal.close(resolve)); await rm(temp, { recursive: true, force: true }); }
});

test('business account role loss fails real-boundary snapshot verification without a grant', async () => {
  const { verifyBusinessRole } = await import('./local-demo-business-account.mjs');
  const config = JSON.parse(await readFile(new URL('./local-demo.config.json', import.meta.url), 'utf8'));
  const anchor = config.name !== 'alp';
  const role = { id: 7, name: anchor ? 'Superadmin' : 'Admin', type: anchor ? 'superadmin' : 'admin' };
  const valid = anchor ? { admin: { roleId: '7', roleName: 'Superadmin' }, user: { admin: { roleId: '7', roleName: 'Superadmin' } } } : { role };
  verifyBusinessRole(valid, role, anchor, config.name);
  const changed = anchor ? { admin: { roleId: '8', roleName: 'Customer' }, user: { admin: { roleId: '8', roleName: 'Customer' } } } : { role: { id: 8, name: 'Authenticated', type: 'authenticated' } };
  assert.throws(() => verifyBusinessRole(changed, role, anchor, config.name), /existing role was preserved/);
  assert.throws(() => verifyBusinessRole({}, role, anchor, config.name), /existing role was preserved/);
  assert.equal(changed[anchor ? 'admin' : 'role'][anchor ? 'roleName' : 'name'], anchor ? 'Customer' : 'Authenticated');
});

test('local HTTP request settles at a total deadline after headers and a dripping body', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{');
    const drip = setInterval(() => response.write(' '), 20);
    response.once('close', () => clearInterval(drip));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const started = performance.now();
  try { await assert.rejects(requestLocal(server.address().port, '/drip', { deadlineMs: 150 }), /total deadline/); assert.ok(performance.now() - started < 1500); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test('foreign reserved SKU product or stock is rejected before any content mutation', async () => {
  const rows = {
    'api::product-variation.product-variation': { id: 103, SKU: 'LOCAL-DEMO-001', product: { id: 999 }, product_stock: { id: 104 } },
    'api::product.product': { id: 102, Slug: 'local-demo-product', Title: 'Local demo' },
    'api::product-stock.product-stock': { id: 104, external_id: 'local-demo-stock-001', external_source: 'local-demo' },
  };
  let writes = 0;
  const api = async (route, options = {}) => {
    if (options.method) { writes++; throw new Error('Unexpected mutation'); }
    return { results: Object.entries(rows).filter(([uid]) => route.split('?')[0].endsWith(uid)).map(([, row]) => row) };
  };
  await assert.rejects(seedContent(api, { kind: 'commerce', productTitle: 'Local demo' }, 1), /foreign or missing product\/stock/);
  assert.equal(writes, 0);
  rows['api::product-variation.product-variation'].product.id = 102;
  rows['api::product-variation.product-variation'].product_stock.id = 999;
  await assert.rejects(seedContent(api, { kind: 'commerce', productTitle: 'Local demo' }, 1), /foreign or missing product\/stock/);
  assert.equal(writes, 0);
});
test('a live child without a listener cannot bind the fixture to a foreign API', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'local-demo-foreign-'));
  const bin = path.join(root, 'backend/node_modules/@strapi/strapi/bin'); await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'strapi.js'), "require('node:fs').writeFileSync('claimed-port',process.env.PORT);setInterval(()=>{},1000);\n");
  let requests = 0; const foreign = createServer((_request, response) => { requests++; response.end(JSON.stringify({ data: { hasAdmin: false } })); });
  const attempt = startOwnedBackend(root, { backend: 'backend' }, new Map([['PORT', '1337']])).then((owned) => ({ owned }), (error) => ({ error }));
  try {
    let port; for (let tries = 0; tries < 50 && !port; tries++) { port = await readFile(path.join(root, 'backend/claimed-port'), 'utf8').catch(() => null); if (!port) await delay(20); }
    assert.ok(port); await new Promise((resolve) => foreign.listen(Number(port), '127.0.0.1', resolve));
    const result = await attempt;
    if (result.owned) await result.owned.stop();
    assert.match(result.error?.message ?? '', /not owned/); assert.equal(requests, 0);
    await assert.rejects(readFile(path.join(root, '.local-demo-credentials.json')), { code: 'ENOENT' });
  } finally { if (foreign.listening) await new Promise((resolve) => foreign.close(resolve)); await rm(root, { recursive: true, force: true }); }
});
test('SIGINT and SIGTERM await teardown of the entire detached child group', async () => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const root = await mkdtemp(path.join(tmpdir(), 'local-demo-cancel-'));
    const bin = path.join(root, 'backend/node_modules/@strapi/strapi/bin'); await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, 'strapi.js'), "const {spawn}=require('node:child_process');const descendant=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});require('node:fs').writeFileSync('child-group.json',JSON.stringify({pid:process.pid,descendant:descendant.pid}));process.on('SIGTERM',()=>{});require('node:http').createServer((req,res)=>res.end(JSON.stringify({data:{hasAdmin:false}}))).listen(Number(process.env.PORT),process.env.HOST);\n");
    const modulePath = fileURLToPath(new URL('./seed-local-demo.mjs', import.meta.url));
    const parent = spawn(process.execPath, ['--input-type=module', '-e', `import { startOwnedBackend } from ${JSON.stringify(modulePath)}; import { writeFile } from 'node:fs/promises'; const owned=await startOwnedBackend(${JSON.stringify(root)},{backend:'backend'},new Map([['PORT','1337']]),{onCancel:()=>writeFile(${JSON.stringify(path.join(root,'cleanup-complete'))},'complete')});await writeFile(${JSON.stringify(path.join(root,'ready-port'))},String(owned.port));setInterval(()=>{},1000);`], { stdio: 'ignore' });
    const exit = new Promise((resolve) => parent.once('exit', (code) => resolve(code)));
    let group;
    try {
      let ready; for (let tries = 0; tries < 250 && !ready; tries++) { ready = await readFile(path.join(root, 'ready-port'), 'utf8').catch(() => null); if (!ready) await delay(20); }
      assert.ok(ready); group = JSON.parse(await readFile(path.join(root, 'backend/child-group.json'), 'utf8'));
      parent.kill(signal);
      assert.equal(await exit, signal === 'SIGINT' ? 130 : 143);
      assert.equal(await readFile(path.join(root, 'cleanup-complete'), 'utf8'), 'complete');
      assert.equal(await ownedGroupAlive({ group: group.pid }), false);
      await assert.rejects(requestLocal(Number(ready), '/admin/init'), /unavailable/);
    } finally { if (parent.exitCode === null) parent.kill('SIGKILL'); if (group && await ownedGroupAlive({group:group.pid})) { try { process.kill(-group.pid,'SIGKILL'); } catch {} } await rm(root, { recursive: true, force: true }); }
  }
});

test('stop tears down owned detached descendants after the CLI parent has exited', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'local-demo-orphan-'));
  const bin = path.join(root, 'backend/node_modules/@strapi/strapi/bin'); await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'strapi.js'), "const {spawn}=require('node:child_process');spawn(process.execPath,['-e',\"require('node:http').createServer((req,res)=>res.end(JSON.stringify({data:{hasAdmin:false}}))).listen(Number(process.env.PORT),process.env.HOST);\"],{stdio:'ignore'});setInterval(()=>{if(require('node:fs').existsSync('exit-now'))process.exit(0)},20);\n");
  let owned;
  try {
    owned = await startOwnedBackend(root, { backend: 'backend' }, new Map([['PORT', '1337']]));
    await writeFile(path.join(root, 'backend/exit-now'), 'exit');
    for (let tries = 0; tries < 100 && owned.alive(); tries++) await delay(20);
    assert.equal(owned.alive(), false);
    const before = await requestLocal(owned.port, '/admin/init'); assert.equal(before.data.hasAdmin, false);
    await owned.stop(); await assert.rejects(requestLocal(owned.port, '/admin/init'), /unavailable/);
  } finally { if (owned) await owned.stop(); await rm(root, { recursive: true, force: true }); }
});

test('unsupported ownership platform refuses before creating files or spawning', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'local-demo-unsupported-'));
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
    await assert.rejects(startOwnedBackend(root, { backend: 'backend' }, new Map([['PORT', '1337']])), /Linux.*WSL/);
    assert.deepEqual(await readdir(root), []);
  } finally { Object.defineProperty(process, 'platform', original); await rm(root, { recursive: true, force: true }); }
});
