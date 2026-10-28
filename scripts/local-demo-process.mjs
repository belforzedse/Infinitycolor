import { readFile, readdir, readlink, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export async function verifySqlitePath(root, config, env) {
  if (!config.sqlite) return;
  const backend = await realpath(path.join(root, config.backend));
  const storage = path.resolve(backend, env.get('DATABASE_FILENAME') ?? '.tmp/data.db');
  if (!storage.startsWith(backend + path.sep)) throw new Error('SQLite storage is outside this local repo');
  const parent = path.dirname(storage);
  const parentEntry = await lstat(parent).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
  if (parentEntry && (parentEntry.isSymbolicLink() || !parentEntry.isDirectory())) throw new Error('SQLite storage parent is not a regular local directory');
  const resolvedParent = await realpath(parent).catch((error) => { if (error.code !== 'ENOENT') throw error; return parent; });
  if (!resolvedParent.startsWith(backend + path.sep)) throw new Error('SQLite storage parent resolves outside this local repo');
  const entry = await lstat(storage).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
  // Refuse every existing filename symlink, including dangling and in-repo links.
  if (entry?.isSymbolicLink()) throw new Error('SQLite database filename is a symlink; no local files or services were changed');
  if (entry && !entry.isFile()) throw new Error('SQLite database filename is not a regular local file');
  if (entry && !(await realpath(storage)).startsWith(backend + path.sep)) throw new Error('SQLite database filename resolves outside this local repo');
}

export async function requireListenerOwnershipPlatform() {
  if (process.platform !== 'linux') throw new Error('Local fixture listener ownership requires Linux /proc. Run this helper inside Linux/WSL; no accounts or content were changed');
  try { await readFile('/proc/net/tcp', 'utf8'); await readdir('/proc/self/fd'); }
  catch { throw new Error('Linux /proc listener ownership is unavailable; no accounts or content were changed'); }
}
async function processStat(pid) {
  try {
    const source = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = source.slice(source.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { pid: Number(pid), state: fields[0], group: Number(fields[2]), start: fields[19] };
  } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw new Error('Process ownership could not be read'); }
}
export async function captureOwnedProcess(pid) {
  const identity = await processStat(pid);
  if (!identity || identity.group !== pid) throw new Error('Spawned backend process group was not established');
  return identity;
}
async function groupMembers(identity) {
  const pids = (await readdir('/proc')).filter((pid) => /^\d+$/.test(pid));
  const records = await Promise.all(pids.map(processStat));
  return records.filter((item) => item?.group === identity.group && item.state !== 'Z' && item.state !== 'X');
}
export async function ownedGroupAlive(identity) { return (await groupMembers(identity)).length > 0; }

// Return false only while no listener exists. Any foreign or unreadable listener fails closed.
export async function verifyOwnedListener(identity, port) {
  const current = await processStat(identity.pid);
  if (!current || current.group !== identity.group || current.start !== identity.start) throw new Error('Owned backend process identity changed or exited');
  const portHex = port.toString(16).toUpperCase().padStart(4, '0');
  const tables = await Promise.all(['tcp', 'tcp6'].map((name) => readFile(`/proc/net/${name}`, 'utf8')));
  const listeners = tables.flatMap((source, index) => source.trim().split('\n').slice(1).map((line) => ({ fields: line.trim().split(/\s+/), ipv6: index === 1 }))).filter(({ fields }) => fields[3] === '0A' && fields[1]?.split(':')[1] === portHex);
  if (!listeners.length) return false;
  if (listeners.some(({ fields, ipv6 }) => ipv6 || fields[1] !== `0100007F:${portHex}`)) throw new Error('Fixture port has an unexpected listener address; no HTTP request was sent');
  const inodes = new Set(listeners.map(({ fields }) => fields[9]));
  await verifyGroupSocketInodes(identity, inodes);
  const after = await processStat(identity.pid);
  if (!after || after.start !== identity.start || after.group !== identity.group) throw new Error('Owned backend exited during listener verification');
  return true;
}

async function verifyGroupSocketInodes(identity, requiredInodes) {
  const owned = new Set();
  for (const member of await groupMembers(identity)) {
    let descriptors;
    try { descriptors = await readdir(`/proc/${member.pid}/fd`); }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw new Error('Owned socket descriptors are unreadable'); }
    for (const descriptor of descriptors) {
      let target;
      try { target = await readlink(`/proc/${member.pid}/fd/${descriptor}`); }
      catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw new Error('Owned socket descriptor could not be verified'); }
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
      if (requiredInodes.has(inode)) owned.add(inode);
    }
  }
  if ([...requiredInodes].some((inode) => !owned.has(inode))) throw new Error('Fixture socket is not owned by the spawned backend process group; no HTTP request was sent');
}

export async function openOwnedConnection(identity, port) {
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('Owned socket connection timed out')); }, 1500);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('error', () => { clearTimeout(timer); reject(new Error('Owned socket is unavailable')); });
    });
    // No request headers or bytes have been sent on this socket. Prove the actual
    // accepted peer inode as well as the listener, then hand this same socket to HTTP.
    if (socket.localAddress !== '127.0.0.1' || !socket.localPort) throw new Error('Loopback socket identity could not be verified');
    const local = `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`;
    const remote = `0100007F:${socket.localPort.toString(16).toUpperCase().padStart(4, '0')}`;
    for (let tries = 0; tries < 25; tries++) {
      if (!await verifyOwnedListener(identity, port)) throw new Error('Owned backend listener disappeared');
      const table = await readFile('/proc/net/tcp', 'utf8');
      const rows = table.trim().split('\n').slice(1).map((line) => line.trim().split(/\s+/)).filter((fields) => fields[1] === local && fields[2] === remote && fields[3] === '01' && fields[9] !== '0');
      if (rows.length === 1) {
        await verifyGroupSocketInodes(identity, new Set([rows[0][9]]));
        if (socket.destroyed) throw new Error('Owned connection closed during verification');
        return socket;
      }
      if (rows.length > 1 || socket.destroyed) throw new Error('Accepted socket identity is ambiguous or closed');
      await delay(20);
    }
    throw new Error('Accepted socket ownership could not be proved; no HTTP request was sent');
  } catch (error) { socket.destroy(); throw error; }
}
