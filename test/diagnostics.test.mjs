import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDiagnostics, normalizeEvent, redact } from "../lib/diagnostics.mjs";

test("diagnostics redact credentials and retain useful error context", () => {
  const message = 'Authorization: Bearer hidden-token-value xi-api-key=secret987654321';
  const cleaned = redact(message);
  assert.ok(!cleaned.includes("hidden-token-value"));
  assert.ok(!cleaned.includes("secret987654321"));
  const event = normalizeEvent({
    level: "error",
    event: "script_failed",
    stage: "frontend",
    requestId: "abc123",
    message,
    stack: "TypeError: x is undefined\n at app.js:84:2",
    transcript: "private user dialogue",
  }, "client");
  assert.equal(event.source, "client");
  assert.equal(event.requestId, "abc123");
  assert.ok(event.stack.includes("app.js:84:2"));
  assert.equal(event.transcript, undefined);
});

test("diagnostics persist events, filter by job and don't store credentials", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "voice-demo-diagnostics-"));
  const file = path.join(dir, "diagnostics.jsonl");
  try {
    const logs = createDiagnostics(file);
    await logs.append({ level: "info", event: "job_created", stage: "upload", jobId: "job-A", message: "上传完成" });
    await logs.append({ level: "error", event: "api_failed", stage: "http", jobId: "job-B", message: "api_key=topsecretvalue", statusCode: 401 }, "client");
    const one = await logs.getRecent({ jobId: "job-A" });
    assert.equal(one.length, 1);
    assert.equal(one[0].event, "job_created");
    const all = await logs.getRecent();
    assert.equal(all.length, 2);
    assert.equal(all[1].statusCode, 401);
    const bytes = await readFile(file, "utf8");
    assert.ok(!bytes.includes("topsecretvalue"));
    assert.ok(bytes.includes('"source":"client"'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
