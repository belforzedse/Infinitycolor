/**
 * Builds and serves the Stories harness (apps/e2e/stories-harness) for
 * stories.playwright.config.ts.
 *
 * Only the page and its bundle are served here. Story media is left to Playwright route
 * interception in the spec, which is what lets a single fixture stand in for a slow
 * response, a stalled one, a 404 and a 500 without a media server that can do all four.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const harnessDir = join(here, "..", "stories-harness");
const port = Number(process.env.STORIES_HARNESS_PORT || 4321);

const build = await esbuild.build({
  entryPoints: [join(harnessDir, "app.tsx")],
  bundle: true,
  format: "esm",
  jsx: "automatic",
  target: ["es2022"],
  write: false,
  outdir: "/out",
  loader: { ".webp": "dataurl" },
  define: { "process.env.NODE_ENV": '"development"' },
});

const assets = new Map();
for (const file of build.outputFiles) {
  assets.set(file.path.replace("/out", ""), file.contents);
}

const html = await readFile(join(harnessDir, "index.html"));

const TYPES = { ".js": "text/javascript", ".css": "text/css" };

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://localhost:${port}`);
  if (url.pathname === "/" || url.pathname === "/index.html") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }
  const asset = assets.get(url.pathname);
  if (asset) {
    const ext = url.pathname.slice(url.pathname.lastIndexOf("."));
    response.writeHead(200, { "Content-Type": TYPES[ext] ?? "application/octet-stream" });
    response.end(Buffer.from(asset));
    return;
  }
  response.writeHead(404).end("not found");
});

server.listen(port, () => {
  console.log(`[stories-harness] listening on http://127.0.0.1:${port}`);
});
