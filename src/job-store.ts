import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const JobStatuses = ["queued", "running", "blocked", "completed", "failed", "cancelled"] as const;
export type JobStatus = (typeof JobStatuses)[number];

export interface JobRecord {
  id: string;
  kind: "capture" | "edit" | "rehearsal" | "workflow" | "render" | "voiceover";
  status: JobStatus;
  stage: string;
  progress: number;
  createdAt: string;
  updatedAt: string;
  request: unknown;
  result?: unknown;
  error?: { code: string; message: string; retryable: boolean };
}

export class JobStore {
  readonly root: string;
  readonly jobsDirectory: string;
  readonly recordingsDirectory: string;
  readonly voiceoversDirectory: string;
  readonly rendersDirectory: string;

  constructor(root = process.env.AGENTCASTKIT_DATA_DIR ?? join(homedir(), "Library", "Application Support", "AgentCastKit")) {
    this.root = root;
    this.jobsDirectory = join(root, "jobs");
    this.recordingsDirectory = join(root, "recordings");
    this.voiceoversDirectory = join(root, "voiceovers");
    this.rendersDirectory = join(root, "renders");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.jobsDirectory, { recursive: true, mode: 0o700 }),
      mkdir(this.recordingsDirectory, { recursive: true, mode: 0o700 }),
      mkdir(this.voiceoversDirectory, { recursive: true, mode: 0o700 }),
      mkdir(this.rendersDirectory, { recursive: true, mode: 0o700 }),
    ]);
  }

  async create(kind: JobRecord["kind"], request: unknown): Promise<JobRecord> {
    const now = new Date().toISOString();
    const job: JobRecord = {
      id: randomUUID(),
      kind,
      status: "queued",
      stage: "queued",
      progress: 0,
      createdAt: now,
      updatedAt: now,
      request,
    };
    await this.write(job);
    return job;
  }

  async get(id: string): Promise<JobRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.pathFor(id), "utf8")) as JobRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async update(id: string, patch: Partial<Omit<JobRecord, "id" | "createdAt">>): Promise<JobRecord> {
    const current = await this.get(id);
    if (!current) throw new Error(`Unknown job: ${id}`);
    const next: JobRecord = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await this.write(next);
    return next;
  }

  async reconcileInterrupted(): Promise<number> {
    let reconciled = 0;
    for (const filename of await readdir(this.jobsDirectory)) {
      if (!filename.endsWith(".json")) continue;
      const job = await this.get(filename.slice(0, -5));
      if (!job || !["queued", "running"].includes(job.status)) continue;
      await this.update(job.id, {
        status: "failed",
        stage: "interrupted",
        error: {
          code: "server_restarted",
          message: "The MCP server restarted while this job was active.",
          retryable: true,
        },
      });
      reconciled += 1;
    }
    return reconciled;
  }

  private pathFor(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid job id");
    return join(this.jobsDirectory, `${id}.json`);
  }

  private async write(job: JobRecord): Promise<void> {
    const target = this.pathFor(job.id);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }
}
