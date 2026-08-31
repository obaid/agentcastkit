import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const appPath = process.argv[2];
assert.ok(appPath, "Expected the packaged .app path.");

const nativeBinary = join(appPath, "Contents", "MacOS", "AgentCastKit Runner");
const server = join(appPath, "Contents", "Resources", "mcp", "dist", "src", "server.js");
const dataDirectory = await mkdtemp(join(tmpdir(), "agentcastkit-live-voice-"));
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
const client = new Client({ name: "agentcastkit-live-voice-test", version: "0.3.0" });

try {
  await client.connect(transport);
  const library = await client.callTool({
    name: "voice_library_list",
    arguments: { scope: "marketplace", page: 1, pageSize: 10, all: false },
  });
  assert.equal(library.isError, false);
  const libraryData = library.structuredContent;
  assert.ok(libraryData && Array.isArray(libraryData.voices));
  const voice = libraryData.voices.find((candidate) => candidate.capabilities?.synthesis === true);
  assert.ok(voice?.id, "Expected a synthesis-capable AgentCastKit voice.");
  assert.equal("provider" in voice, false);
  assert.equal("providerVoiceId" in voice, false);
  assert.equal(voice.source, "marketplace");
  assert.equal("preview_url" in voice, false);

  const identifier = `mcp-live-${Date.now()}`;
  const synthesis = await client.callTool({
    name: "voiceover_synthesize",
    arguments: {
      voiceId: voice.id,
      text: "This voiceover was generated through the AgentCastKit MCP contract.",
      outputFormat: "mp3",
      quality: "standard",
      filename: `${identifier}.mp3`,
      idempotencyKey: identifier,
    },
  });
  assert.equal(synthesis.isError, false);
  const speech = synthesis.structuredContent;
  assert.ok(speech?.artifact?.path);
  await access(speech.artifact.path);
  assert.ok((await readFile(speech.artifact.path)).byteLength > 0);

  process.stdout.write(`${JSON.stringify({
    voiceCount: libraryData.voices.length,
    selectedVoice: voice.name,
    generationId: speech.generationId,
    durationSeconds: speech.durationSeconds,
    bytes: speech.artifact.bytes,
    mimeType: speech.artifact.mimeType,
  }, null, 2)}\n`);
} finally {
  await client.close();
  await rm(dataDirectory, { recursive: true, force: true });
}
