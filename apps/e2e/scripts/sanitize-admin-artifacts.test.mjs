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

test("sanitizes traces nested in a sharded run's blob report", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "blob-artifacts-"));
  const trace = new JSZip();
  trace.file("trace.trace", `${JSON.stringify({ type: "action", url: "https://staging.test/auth/callback?grant=credential" })}\n`);
  trace.file("trace.network", `${JSON.stringify({ headers: [{ name: "cookie", value: "credential" }] })}\n`);
  const blob = new JSZip();
  blob.file("report.jsonl", `${JSON.stringify({ method: "onEnd", params: { url: "https://staging.test/x?token=credential" } })}\n`);
  blob.file("resources/0123abcd.zip", await trace.generateAsync({ type: "nodebuffer" }));
  const blobPath = path.join(directory, "report-1.zip");
  await writeFile(blobPath, await blob.generateAsync({ type: "nodebuffer" }));

  await sanitizeAdminArtifacts({ roots: [directory], secretValues: ["credential"] });

  const sanitizedBlob = await JSZip.loadAsync(await readFile(blobPath));
  assert.doesNotMatch(await sanitizedBlob.file("report.jsonl").async("string"), /credential/);
  const inner = await JSZip.loadAsync(await sanitizedBlob.file("resources/0123abcd.zip").async("nodebuffer"));
  assert.equal(inner.file("trace.network"), null);
  assert.doesNotMatch(await inner.file("trace.trace").async("string"), /credential|grant=/);
});
