#!/usr/bin/env node
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CaptureRunner } from "./capture-runner.js";
import { JobStore } from "./job-store.js";
import { NativeClient, type CaptureSource, type PermissionStatus } from "./native-client.js";
import { validatePlan } from "./protocol.js";

const store = new JobStore();
await store.initialize();
await store.reconcileInterrupted();
const native = new NativeClient();
const captures = new CaptureRunner(store, native);

const recorderDescription = {
  product: "AgentCastKit",
  version: "0.1.0",
  platform: "macOS 15+",
  transport: "stdio",
  capabilities: ["permission_status", "source_listing", "display_or_window_capture", "durable_jobs", "demo_plan_validation"],
  privacy: { literalKeystrokeCapture: false, secretsByReference: true, automaticUpload: false },
  milestoneLimitations: [
    "The proof-of-life recorder writes one MP4; separate editable tracks come next.",
    "Browser rehearsal, semantic action telemetry, Resemble voiceover, editing, and rendering are not implemented yet.",
    "Capture requires a logged-in macOS graphical session and Screen Recording permission.",
  ],
};

const server = new McpServer({
  name: "agentcastkit",
  version: "0.1.0",
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
