import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { availableArtifactPath } from "../src/artifact-path.js";

test("preserves a requested artifact name when it is available", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentcastkit-artifact-"));
  const path = await availableArtifactPath(directory, "demo", "801bdbfe-cec6-4fba-868a-4b029a75c567", ".mp4");
  assert.equal(basename(path), "demo.mp4");
});

test("adds a stable job suffix instead of failing when an artifact exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentcastkit-artifact-"));
  await writeFile(join(directory, "demo.mp4"), "existing");
  const path = await availableArtifactPath(directory, "demo.mp4", "801bdbfe-cec6-4fba-868a-4b029a75c567", ".mp4");
  assert.equal(basename(path), "demo-801bdbfe.mp4");
});
