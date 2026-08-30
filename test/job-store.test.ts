import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JobStore } from "../src/job-store.js";

test("persists and updates a job atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentcastkit-job-store-"));
  const store = new JobStore(root);
  await store.initialize();
  const created = await store.create("capture", { sourceId: "display:1" });
  const completed = await store.update(created.id, { status: "completed", stage: "done", progress: 1 });
  assert.equal(completed.status, "completed");
  const raw = JSON.parse(await readFile(join(root, "jobs", `${created.id}.json`), "utf8"));
  assert.equal(raw.progress, 1);
});

test("reconciles work interrupted by a server restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentcastkit-reconcile-"));
  const store = new JobStore(root);
  await store.initialize();
  const created = await store.create("capture", {});
  await store.update(created.id, { status: "running", stage: "recording" });
  assert.equal(await store.reconcileInterrupted(), 1);
  const reconciled = await store.get(created.id);
  assert.equal(reconciled?.status, "failed");
  assert.equal(reconciled?.error?.code, "server_restarted");
});
