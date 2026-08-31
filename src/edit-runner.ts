import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { availableArtifactPath } from "./artifact-path.js";
import {
  EditPlanSchema,
  buildEditPlan,
  withEditSegments,
  type EditPlan,
  type EditProfile,
  type EditSegment,
  type MediaAnalysis,
  type MediaInspection,
} from "./editing.js";
import { JobStore, type JobRecord } from "./job-store.js";
import { NativeClient, type NativeResponse } from "./native-client.js";

export interface EditAnalysisRequest {
  sourceJobId: string;
  profile: EditProfile;
  sampleFramesPerSecond: number;
}

export interface RenderRequest {
  editJobId: string;
  filename?: string | undefined;
}

interface RenderArtifact {
  path: string;
  durationSeconds: number;
  bytes: number;
  segmentCount: number;
}

export class EditRunner {
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(
    private readonly store: JobStore,
    private readonly native: NativeClient,
  ) {}

  async inspect(jobId: string): Promise<NativeResponse<MediaInspection>> {
    const job = await this.requireArtifactJob(jobId);
    return this.native.run<MediaInspection>(["media", "inspect", "--input", artifactPath(job)]);
  }

  async analyze(request: EditAnalysisRequest): Promise<JobRecord> {
    await this.requireArtifactJob(request.sourceJobId);
    const job = await this.store.create("edit", request);
    void this.runAnalysis(job.id, request);
    return job;
  }

  async plan(editJobId: string): Promise<EditPlan> {
    const job = await this.store.get(editJobId);
    if (!job || job.kind !== "edit") throw new Error(`Unknown edit job: ${editJobId}`);
    const candidate = (job.result as { plan?: unknown } | undefined)?.plan;
    if (!candidate) throw new Error(`Edit plan is not ready: ${editJobId}`);
    return EditPlanSchema.parse(candidate);
  }

  async updatePlan(editJobId: string, segments: EditSegment[]): Promise<JobRecord> {
    const current = await this.plan(editJobId);
    const plan = withEditSegments(current, segments);
    return this.store.update(editJobId, {
      status: "completed",
      stage: "plan_ready",
      progress: 1,
      result: { plan },
    });
  }

  async render(request: RenderRequest): Promise<JobRecord> {
    const plan = await this.plan(request.editJobId);
    const job = await this.store.create("render", { editJobId: request.editJobId, plan, filename: request.filename });
    void this.runRender(job.id, request.editJobId, plan, request.filename);
    return job;
  }

  async cancel(jobId: string): Promise<JobRecord> {
    const job = await this.store.get(jobId);
    if (!job || !["edit", "render"].includes(job.kind)) throw new Error(`Unknown edit or render job: ${jobId}`);
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    this.processes.get(jobId)?.kill("SIGINT");
    return this.store.update(jobId, { status: "cancelled", stage: "cancelled" });
  }

  private async runAnalysis(jobId: string, request: EditAnalysisRequest): Promise<void> {
    try {
      const source = await this.requireArtifactJob(request.sourceJobId);
      await this.store.update(jobId, { status: "running", stage: "analyzing_activity", progress: 0.1 });
      const child = this.native.start([
        "media", "analyze",
        "--input", artifactPath(source),
        "--sample-fps", String(request.sampleFramesPerSecond),
      ]);
      child.stdin.end();
      this.processes.set(jobId, child);
      this.collect(jobId, child, "analysis_failed", async (analysis: MediaAnalysis) => {
        const plan = buildEditPlan(request.sourceJobId, analysis, request.profile);
        await this.store.update(jobId, {
          status: "completed",
          stage: "plan_ready",
          progress: 1,
          result: { plan },
        });
      });
    } catch (error) {
      await this.fail(jobId, "analysis_failed", error);
    }
  }

  private async runRender(jobId: string, editJobId: string, plan: EditPlan, filename?: string): Promise<void> {
    try {
      const requested = filename ?? `render-${jobId}.mp4`;
      const outputPath = await availableArtifactPath(this.store.rendersDirectory, requested, jobId, ".mp4");
      await this.store.update(jobId, { status: "running", stage: "rendering", progress: 0.1 });
      const child = this.native.start([
        "media", "render",
        "--input", plan.sourceArtifact.path,
        "--output", outputPath,
      ]);
      child.stdin.end(JSON.stringify({ segments: plan.segments }));
      this.processes.set(jobId, child);
      this.collect(jobId, child, "render_failed", async (artifact: RenderArtifact) => {
        const removedSeconds = plan.removedRanges.reduce(
          (total, range) => total + range.endSeconds - range.startSeconds,
          0,
        );
        await this.store.update(jobId, {
          status: "completed",
          stage: "rendered",
          progress: 1,
          result: {
            editJobId,
            artifact: { uri: `file://${artifact.path}`, path: artifact.path, mimeType: "video/mp4", bytes: artifact.bytes },
            sourceDurationSeconds: plan.sourceDurationSeconds,
            durationSeconds: artifact.durationSeconds,
            removedSeconds,
            timeSavedSeconds: Math.max(0, plan.sourceDurationSeconds - artifact.durationSeconds),
            segmentCount: artifact.segmentCount,
          },
        });
      });
    } catch (error) {
      await this.fail(jobId, "render_failed", error);
    }
  }

  private collect<T>(
    jobId: string,
    child: ChildProcessWithoutNullStreams,
    failureCode: string,
    onSuccess: (data: T) => Promise<void>,
  ): void {
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", async (error) => {
      if (settled) return;
      settled = true;
      this.processes.delete(jobId);
      await this.fail(jobId, "native_spawn_failed", error);
    });
    child.on("close", async (code) => {
      if (settled) return;
      settled = true;
      this.processes.delete(jobId);
      const current = await this.store.get(jobId);
      if (!current || current.status === "cancelled") return;
      let response: NativeResponse<T>;
      try {
        response = JSON.parse(stdout.trim()) as NativeResponse<T>;
      } catch {
        response = { ok: false, error: { code: "native_protocol_error", message: stderr.trim() || `Native worker exited ${code ?? "unknown"}` } };
      }
      if (!response.ok || !response.data) {
        await this.fail(jobId, response.error?.code ?? failureCode, new Error(response.error?.message ?? `${failureCode} without a diagnostic.`));
        return;
      }
      try {
        await onSuccess(response.data);
      } catch (error) {
        await this.fail(jobId, failureCode, error);
      }
    });
  }

  private async fail(jobId: string, code: string, error: unknown): Promise<void> {
    const current = await this.store.get(jobId);
    if (!current || current.status === "cancelled") return;
    await this.store.update(jobId, {
      status: "failed",
      stage: code,
      error: { code, message: error instanceof Error ? error.message : String(error), retryable: true },
    });
  }

  private async requireArtifactJob(jobId: string): Promise<JobRecord> {
    const job = await this.store.get(jobId);
    if (!job || !["capture", "render"].includes(job.kind) || job.status !== "completed") {
      throw new Error(`A completed capture or render job is required: ${jobId}`);
    }
    artifactPath(job);
    return job;
  }
}

function artifactPath(job: JobRecord): string {
  const artifact = (job.result as { artifact?: { path?: string; uri?: string } } | undefined)?.artifact;
  if (artifact?.path) return artifact.path;
  if (artifact?.uri?.startsWith("file://")) return fileURLToPath(artifact.uri);
  throw new Error(`Job ${job.id} has no local video artifact.`);
}
