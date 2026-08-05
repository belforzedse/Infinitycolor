import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { sanitizeAdminArtifacts } from "./sanitize-admin-artifacts.mjs";

test("removes auth state, network traces, non-image resources, queries, and credential values", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "admin-artifacts-"));
  const report = path.join(directory, "report");
  const auth = path.join(directory, ".auth");
  await mkdir(report, { recursive: true });
  await mkdir(auth, { recursive: true });
  await writeFile(path.join(auth, "admin.json"), '{"cookie":"credential"}');
  await writeFile(
    path.join(report, "junit.xml"),
    '<failure>Authorization: Bearer credential https://admin.test/orders/12?token=credential</failure>',
  );

  const archive = new JSZip();
  archive.file("trace.trace", `${JSON.stringify({ type: "action", password: "credential", url: "https://admin.test/orders/12?token=credential" })}\n`);
  archive.file("trace.network", `${JSON.stringify({ headers: [{ name: "cookie", value: "credential" }] })}\n`);
  archive.file("resources/body", Buffer.from('{"token":"credential"}'));
  archive.file("resources/frame", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  const tracePath = path.join(report, "trace.zip");
  await writeFile(tracePath, await archive.generateAsync({ type: "nodebuffer" }));

  await sanitizeAdminArtifacts({ roots: [report], authDir: auth, secretValues: ["credential"] });

  await assert.rejects(readFile(path.join(auth, "admin.json")));
  const junit = await readFile(path.join(report, "junit.xml"), "utf8");
  assert.doesNotMatch(junit, /credential|\?token=/);

  const sanitized = await JSZip.loadAsync(await readFile(tracePath));
  assert.equal(sanitized.file("trace.network"), null);
  assert.equal(sanitized.file("resources/body"), null);
  assert.ok(sanitized.file("resources/frame"));
  const trace = await sanitized.file("trace.trace").async("string");
  assert.doesNotMatch(trace, /credential|\?token=/);
  assert.match(trace, /REDACTED/);
});
