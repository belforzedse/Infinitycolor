/**
 * Jest globalTeardown for the backend integration layer (runs once, parent process).
 * Stops the disposable Postgres container (if we started one) and removes the
 * connection temp file. Throwing the container away IS the cleanup — no real DB
 * is ever mutated, so there is nothing else to undo.
 */
import fs from "fs";
import { CONN_FILE } from "./env";

export default async function globalTeardown() {
  const container = (globalThis as any).__PG_CONTAINER__;
  if (container?.stop) {
    try {
      await container.stop();
    } catch {
      /* container already gone */
    }
  }
  try {
    if (fs.existsSync(CONN_FILE)) fs.unlinkSync(CONN_FILE);
  } catch {
    /* best effort */
  }
}
