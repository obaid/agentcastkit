import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const appPath = process.argv[2];
assert.ok(appPath, "Expected the packaged .app path.");

const nativeBinary = join(appPath, "Contents", "MacOS", "AgentCastKit Runner");
const server = join(appPath, "Contents", "Resources", "mcp", "dist", "src", "server.js");
const dataDirectory = await mkdtemp(join(tmpdir(), "agentcastkit-packaged-mcp-"));
const transport = new StdioClientTransport({
  command: "/usr/bin/env",
  args: ["node", server],
  env: {
    ...getDefaultEnvironment(),
    AGENTCASTKIT_CAPTURE_BIN: nativeBinary,
    AGENTCASTKIT_DATA_DIR: dataDirectory,
  },
  stderr: "pipe",
});
const client = new Client({ name: "agentcastkit-packaging-test", version: "0.1.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 8);
  assert.ok(tools.tools.some((tool) => tool.name === "capture_start"));

  const description = await client.callTool({ name: "recorder_describe", arguments: {} });
  assert.equal(description.structuredContent?.product, "AgentCastKit");
  process.stdout.write("Packaged MCP smoke test passed.\n");
} finally {
  await client.close();
  await rm(dataDirectory, { recursive: true, force: true });
}
