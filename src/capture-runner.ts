import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { basename, join } from "node:path";
import { JobStore, type JobRecord } from "./job-store.js";
import { NativeClient, type NativeResponse } from "./native-client.js";

export interface CaptureRequest {
  sourceId: string;
  durationSeconds: number;
  framesPerSecond: number;
  captureSystemAudio: boolean;
  showCursor: boolean;
  filename?: string | undefined;
}

export class CaptureRunner {
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(
    private readonly store: JobStore,
    private readonly native: NativeClient,
  ) {}

  async start(request: CaptureRequest): Promise<JobRecord> {
    const job = await this.store.create("capture", request);
    void this.run(job.id, request);
    return job;
  }

  async cancel(jobId: string): Promise<JobRecord> {
    const job = await this.store.get(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    this.processes.get(jobId)?.kill("SIGINT");
    return this.store.update(jobId, { status: "cancelled", stage: "cancelled" });
  }

  private async run(jobId: string, request: CaptureRequest): Promise<void> {
    if (!(await this.native.available())) {
      await this.store.update(jobId, {
        status: "failed",
        stage: "native_worker_missing",
        error: { code: "native_worker_missing", message: "Run npm run native:build.", retryable: true },
      });
      return;
    }

    const safeName = basename(request.filename ?? `capture-${jobId}.mp4`).replace(/[^a-zA-Z0-9._-]/g, "-");
    const outputPath = join(this.store.recordingsDirectory, safeName.endsWith(".mp4") ? safeName : `${safeName}.mp4`);
    const args = [
      "record",
      "--source",
      request.sourceId,
      "--output",
      outputPath,
      "--duration",
      String(request.durationSeconds),
      "--fps",
      String(request.framesPerSecond),
      "--system-audio",
      String(request.captureSystemAudio),
      "--cursor",
      String(request.showCursor),
    ];

    await this.store.update(jobId, { status: "running", stage: "recording", progress: 0.05 });
    const child = this.native.start(args);
    this.processes.set(jobId, child);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));

    child.on("close", async (code) => {
      this.processes.delete(jobId);
      const current = await this.store.get(jobId);
      if (!current || current.status === "cancelled") return;
      let response: NativeResponse<{ path: string; durationSeconds: number; bytes: number }>;
      try {
        response = JSON.parse(stdout.trim()) as typeof response;
      } catch {
        response = {
          ok: false,
          error: { code: "native_protocol_error", message: stderr.trim() || `Native worker exited ${code ?? "unknown"}` },
        };
      }

      if (!response.ok || !response.data) {
        await this.store.update(jobId, {
          status: "failed",
          stage: "capture_failed",
          error: {
            code: response.error?.code ?? "capture_failed",
            message: response.error?.message ?? "Capture failed without a diagnostic.",
            retryable: true,
          },
        });
        return;
      }

      await this.store.update(jobId, {
        status: "completed",
        stage: "recorded",
        progress: 1,
        result: {
          artifact: { uri: `file://${response.data.path}`, mimeType: "video/mp4", bytes: response.data.bytes },
          durationSeconds: response.data.durationSeconds,
        },
      });
    });
  }
}
