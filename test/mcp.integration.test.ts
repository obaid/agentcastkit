import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PlanVersion } from "../src/protocol.js";

test("serves tools and resources over a real stdio MCP connection", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "agentcastkit-mcp-"));
  const projectDirectory = resolve(import.meta.dirname, "..");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server.ts"],
    cwd: projectDirectory,
    env: { ...getDefaultEnvironment(), AGENTCASTKIT_DATA_DIR: dataDirectory },
    stderr: "pipe",
  });
  const client = new Client({ name: "agentcastkit-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      [
        "recorder_describe",
        "permissions_status",
        "permissions_request",
        "sources_list",
        "plan_validate",
        "capture_start",
        "job_get",
        "job_cancel",
      ],
    );

    const description = await client.callTool({ name: "recorder_describe", arguments: {} });
    assert.equal((description.structuredContent as { product: string }).product, "AgentCastKit");

    const planValidation = await client.callTool({
      name: "plan_validate",
      arguments: {
        plan: {
          version: PlanVersion,
          title: "Test plan",
          objective: "Validate the transport.",
          audience: "Developers",
          targetDurationSeconds: 20,
          source: { kind: "display" },
          driver: { kind: "manual" },
          steps: [{ id: "checkpoint", title: "Checkpoint", action: "checkpoint", expected: "Ready" }],
        },
      },
    });
    assert.equal((planValidation.structuredContent as { valid: boolean }).valid, true);

    const resources = await client.listResources();
    assert.equal(resources.resources[0]?.uri, "agentcastkit://recorder/capabilities");
    const capability = await client.readResource({ uri: "agentcastkit://recorder/capabilities" });
    const firstContent = capability.contents[0];
    assert.ok(firstContent && "text" in firstContent);
    assert.match(firstContent.text, /AgentCastKit/);
  } finally {
    await client.close();
  }
});
