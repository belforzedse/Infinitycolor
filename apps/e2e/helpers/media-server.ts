import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";

/**
 * A real HTTP media origin for playback tests: byte ranges, CORS and immutable caching
 * like the production CDN (`cdn.infinitycolor.co/uploads/*`), plus per-path faults.
 *
 * Route interception cannot stand in here: throttled delivery (CDP network emulation)
 * and progressive range reads only happen on real sockets, and hls.js fetches playlists
 * and segments with XHR/fetch where CORS actually matters.
 */

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".m4s": "video/iso.segment",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
};

export type MediaFault =
  | { kind: "status"; status: number }
  /** Serve the file but without `Access-Control-Allow-Origin` (prod before the gateway fix). */
  | { kind: "no-cors" }
  | { kind: "delay"; ms: number };

export interface MediaServer {
  origin: string;
  url(path: string): string;
  /** Paths requested so far, in order (without the /uploads/ prefix). */
  requests: string[];
  faults: Map<string, MediaFault>;
  close(): Promise<void>;
}

export async function startMediaServer(root: string): Promise<MediaServer> {
  const requests: string[] = [];
  const faults = new Map<string, MediaFault>();

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const relative = decodeURIComponent(url.pathname).replace(/^\/uploads\//, "");
    const safe = normalize(relative).replace(/^(\.\.[/\\])+/, "");
    requests.push(safe);
    // `alias-<anything>/` serves the same files under URLs no browser has cached yet — the
    // fixtures are `immutable`, and some engines share the HTTP cache across test contexts.
    const filePath = safe.replace(/^alias-[\w-]+\//, "");

    const fault = faults.get(safe) ?? [...faults.entries()].find(([key]) => key.endsWith("*") && safe.startsWith(key.slice(0, -1)))?.[1];
    const cors = fault?.kind !== "no-cors";
    const headers: Record<string, string> = {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Accept-Ranges": "bytes",
      ...(cors ? { "Access-Control-Allow-Origin": "*" } : {}),
    };

    if (request.method === "OPTIONS") {
      response.writeHead(204, { ...headers, "Access-Control-Allow-Headers": "Range", "Access-Control-Allow-Methods": "GET, HEAD" });
      response.end();
      return;
    }
    if (fault?.kind === "status") {
      response.writeHead(fault.status, headers);
      response.end(`fault ${fault.status}`);
      return;
    }
    if (fault?.kind === "delay") await new Promise((resolve) => setTimeout(resolve, fault.ms));

    const path = join(root, filePath);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      response.writeHead(404, headers);
      response.end("not found");
      return;
    }
    headers["Content-Type"] = TYPES[extname(path)] ?? "application/octet-stream";

    const range = /bytes=(\d*)-(\d*)/.exec(String(request.headers.range ?? ""));
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      response.writeHead(206, {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      });
      if (request.method === "HEAD") return void response.end();
      createReadStream(path, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, { ...headers, "Content-Length": String(size) });
    if (request.method === "HEAD") return void response.end();
    createReadStream(path).pipe(response);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    url: (path) => `${origin}/uploads/${path}`,
    requests,
    faults,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
