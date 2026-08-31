#!/usr/bin/env node
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { z } from "zod";
import { CaptureRunner } from "./capture-runner.js";
import { JobStore } from "./job-store.js";
import {
  NativeClient,
  type CaptureSource,
  type CloudSpeechArtifact,
  type CloudVoiceLibrary,
  type PermissionStatus,
} from "./native-client.js";
import { validatePlan } from "./protocol.js";
import { productPolicy } from "./product-policy.js";

const store = new JobStore();
await store.initialize();
await store.reconcileInterrupted();
const native = new NativeClient();
const captures = new CaptureRunner(store, native);

const recorderDescription = {
  product: "AgentCastKit",
  version: "0.3.0",
  platform: "macOS 15+",
  transport: "stdio",
  capabilities: [
    "permission_status",
    "source_listing",
    "display_or_window_capture",
    "durable_jobs",
    "demo_plan_validation",
    "cua_driver_companion_mcp",
    "provider_neutral_voice_library",
    "managed_voiceover_synthesis",
  ],
  privacy: { literalKeystrokeCapture: false, secretsByReference: true, automaticUpload: false },
  automation: { provider: "Cua Driver", version: "0.22.2", mcpServer: "cua-driver", installedBy: "npx agentcastkit install" },
  featurePolicy: productPolicy,
  milestoneLimitations: [
    "The proof-of-life recorder writes one MP4; separate editable tracks come next.",
    "Cua Driver supplies GUI and browser control through a companion MCP; AgentCastKit does not yet persist semantic action telemetry.",
    "Editing and final rendering are not implemented yet.",
    "Capture requires a logged-in macOS graphical session and Screen Recording permission.",
  ],
};

const server = new McpServer({
  name: "agentcastkit",
  version: "0.3.0",
});

server.registerResource(
  "recorder-capabilities",
  "agentcastkit://recorder/capabilities",
  {
    title: "AgentCastKit recorder capabilities",
    description: "Stable machine-readable capability and limitation description.",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(recorderDescription, null, 2) }],
  }),
);

server.registerResource(
  "product-feature-policy",
  "agentcastkit://product/feature-policy",
  {
    title: "AgentCastKit feature policy",
    description: "Machine-readable free and paid product boundary.",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(productPolicy, null, 2) }],
  }),
);

server.registerResource(
  "job",
  new ResourceTemplate("agentcastkit://jobs/{jobId}", { list: undefined }),
  {
    title: "AgentCastKit job",
    description: "Durable status and artifacts for one capture, rehearsal, voiceover, render, or workflow job.",
    mimeType: "application/json",
  },
  async (uri, variables) => {
    const variable = variables.jobId;
    const jobId = Array.isArray(variable) ? variable[0] : variable;
    const job = jobId ? await store.get(jobId) : undefined;
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(job ? { job } : { error: { code: "job_not_found", message: `Unknown job: ${jobId ?? ""}` } }, null, 2),
        },
      ],
    };
  },
);

function result(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
    isError,
  };
}

server.registerTool(
  "recorder_describe",
  {
    title: "Describe AgentCastKit recorder",
    description: "Returns the local recorder's capabilities, architectural boundaries, and current milestone limitations.",
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async () => result(recorderDescription),
);

server.registerTool(
  "product_features",
  {
    title: "Describe free and paid features",
    description: "Returns the stable AgentCastKit product boundary. Local capture and computer control remain free; managed cloud and collaboration features require entitlements.",
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async () => result(productPolicy),
);

server.registerTool(
  "permissions_status",
  {
    title: "Inspect capture permissions",
    description: "Reads Screen Recording, microphone, and camera authorization without prompting.",
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async () => {
    const response = await native.run<PermissionStatus>(["permissions", "status"]);
    return result(response, !response.ok);
  },
);

server.registerTool(
  "permissions_request",
  {
    title: "Request a capture permission",
    description: "Opens the macOS authorization prompt. Call only after the user explicitly approves the named permission.",
    inputSchema: {
      permission: z.enum(["screen", "microphone", "camera"]),
      userConfirmed: z.literal(true),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
  },
  async ({ permission }) => {
    const response = await native.run<PermissionStatus>(["permissions", "request", permission]);
    return result(response, !response.ok);
  },
);

server.registerTool(
  "sources_list",
  {
    title: "List recordable sources",
    description: "Lists displays and visible windows available to ScreenCaptureKit. This does not begin recording.",
    inputSchema: {
      kinds: z.array(z.enum(["display", "window"])).default(["display", "window"]),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ kinds }) => {
    const response = await native.run<CaptureSource[]>(["sources", "list"]);
    if (response.ok && response.data) response.data = response.data.filter((source) => kinds.includes(source.kind));
    return result(response, !response.ok);
  },
);

server.registerTool(
  "plan_validate",
  {
    title: "Validate a demo plan",
    description: "Validates the agent-facing demo plan, privacy invariants, step identifiers, and narration density without executing it.",
    inputSchema: { plan: z.unknown() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ plan }) => {
    const validation = validatePlan(plan);
    return result(validation, !validation.valid);
  },
);

server.registerTool(
  "voice_library_list",
  {
    title: "List AgentCastKit voices",
    description: "Paid feature. Lists provider-neutral AgentCastKit voice IDs and normalized marketplace metadata. Provider credentials and provider-specific IDs are never returned.",
    inputSchema: {
      scope: z.enum(["marketplace", "available"]).default("marketplace"),
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(10).max(1_000).default(1_000),
      all: z.boolean().default(true).describe("Fetch every page beginning at page. Capped at 20 pages."),
      includePreviews: z.boolean().default(false).describe("Include provider-hosted voice preview URLs. Disabled by default to keep agent context compact."),
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ scope, page, pageSize, all, includePreviews }) => {
    const voices: CloudVoiceLibrary["voices"] = [];
    let currentPage = page;
    let latest: CloudVoiceLibrary | undefined;

    for (let fetched = 0; fetched < 20; fetched += 1) {
      const response = await native.run<CloudVoiceLibrary>([
        "cloud",
        "voice-library",
        "--scope",
        scope,
        "--page",
        String(currentPage),
        "--page-size",
        String(pageSize),
        "--include-previews",
        String(includePreviews),
      ]);
      if (!response.ok || !response.data) return result(response, true);
      latest = response.data;
      voices.push(...response.data.voices);
      if (!all || !response.data.hasMore) break;
      currentPage += 1;
    }

    return result({
      voices,
      meta: {
        firstPage: page,
        lastPage: latest?.page ?? page,
        pageSize,
        returned: voices.length,
        total: latest?.total,
        complete: latest ? !latest.hasMore : true,
      },
    });
  },
);

server.registerTool(
  "voiceover_synthesize",
  {
    title: "Generate a managed voiceover",
    description: "Paid feature. Generates a voiceover from plain text using an AgentCastKit voice ID, saves it locally, and returns timing plus artifact metadata.",
    inputSchema: {
      voiceId: z.string().uuid(),
      text: z.string().min(1).max(3_000),
      outputFormat: z.enum(["wav", "mp3"]).default("wav"),
      quality: z.enum(["standard", "high"]).default("standard"),
      filename: z.string().regex(/^[a-zA-Z0-9._-]+$/).optional(),
      idempotencyKey: z.string().regex(/^[a-zA-Z0-9._:-]+$/).max(120).optional(),
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  async ({ voiceId, text, outputFormat, quality, filename, idempotencyKey }) => {
    const identifier = idempotencyKey ?? randomUUID();
    const requestedName = basename(filename ?? `voiceover-${identifier}.${outputFormat}`).replace(/[^a-zA-Z0-9._-]/g, "-");
    const safeName = requestedName.endsWith(`.${outputFormat}`) ? requestedName : `${requestedName}.${outputFormat}`;
    const outputPath = join(store.voiceoversDirectory, safeName);
    const response = await native.run<CloudSpeechArtifact>(
      ["cloud", "synthesize", "--output", outputPath],
      JSON.stringify({ voiceId, text, outputFormat, quality, idempotencyKey: identifier }),
    );
    if (!response.ok || !response.data) return result(response, true);

    return result({
      generationId: response.data.id,
      voiceId: response.data.voiceID,
      characters: response.data.characters,
      quality: response.data.quality,
      durationSeconds: response.data.durationSeconds,
      sampleRate: response.data.sampleRate,
      timing: response.data.timing,
      issues: response.data.issues,
      artifact: {
        uri: `file://${response.data.path}`,
        path: response.data.path,
        mimeType: response.data.outputFormat === "mp3" ? "audio/mpeg" : "audio/wav",
        bytes: response.data.bytes,
      },
    });
  },
);

server.registerTool(
  "capture_start",
  {
    title: "Start a bounded local recording",
    description: "Starts a display or window recording as a durable background job and returns immediately with a job id.",
    inputSchema: {
      sourceId: z.string().regex(/^(display|window):\d+$/),
      durationSeconds: z.number().int().min(1).max(3_600).default(15),
      framesPerSecond: z.number().int().min(1).max(120).default(60),
      captureSystemAudio: z.boolean().default(true),
      showCursor: z.boolean().default(true),
      filename: z.string().regex(/^[a-zA-Z0-9._-]+$/).optional(),
      userConfirmed: z.literal(true).describe("Confirms the user approved recording this source now."),
    },
    annotations: { readOnlyHint: false, idempotentHint: false },
  },
  async ({ userConfirmed: _userConfirmed, ...request }) => result({ job: await captures.start(request), pollWith: "job_get" }),
);

server.registerTool(
  "job_get",
  {
    title: "Get job status",
    description: "Returns durable status, progress, error, and artifact metadata for one job.",
    inputSchema: { jobId: z.string().uuid() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ jobId }) => {
    const job = await store.get(jobId);
    return job ? result({ job }) : result({ error: { code: "job_not_found", message: `Unknown job: ${jobId}` } }, true);
  },
);

server.registerTool(
  "job_cancel",
  {
    title: "Cancel a running job",
    description: "Cancels a queued or running job. A partial recording is not published.",
    inputSchema: { jobId: z.string().uuid() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  async ({ jobId }) => {
    try {
      return result({ job: await captures.cancel(jobId) });
    } catch (error) {
      return result({ error: { code: "job_not_found", message: (error as Error).message } }, true);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
