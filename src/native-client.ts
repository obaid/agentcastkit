import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface NativeResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export interface PermissionStatus {
  screen: string;
  microphone: string;
  camera: string;
}

export interface CaptureSource {
  id: string;
  kind: "display" | "window";
  name: string;
  application?: string;
  width: number;
  height: number;
  x: number;
  y: number;
  scale?: number;
}

export interface CloudVoice {
  id: string;
  name: string;
  status: string;
  default_language?: string;
  supported_languages: string[];
  source?: string;
  preview_url?: string;
  capabilities: Record<string, boolean>;
}

export interface CloudVoiceLibrary {
  voices: CloudVoice[];
  page: number;
  pageSize: number;
  total?: number;
  pages?: number;
  hasMore: boolean;
}

export interface CloudSpeechArtifact {
  id: string;
  path: string;
  bytes: number;
  voiceID: string;
  characters: number;
  outputFormat: "wav" | "mp3";
  quality: "standard" | "high";
  sampleRate?: number;
  durationSeconds?: number;
  timing: Array<{ value: string; startSeconds: number; endSeconds: number }>;
  issues: string[];
}

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(sourceDirectory, "..");

export class NativeClient {
  readonly binary: string;

  constructor(binary = process.env.AGENTCASTKIT_CAPTURE_BIN ?? resolve(projectRoot, "native", ".build", "debug", "agentcastkit-capture")) {
    this.binary = binary;
  }

  async available(): Promise<boolean> {
    try {
      await access(this.binary);
      return true;
    } catch {
      return false;
    }
  }

  async run<T>(args: string[], stdin?: string): Promise<NativeResponse<T>> {
    if (!(await this.available())) {
      return {
        ok: false,
        error: {
          code: "native_worker_missing",
          message: `Native worker not found at ${this.binary}. Run npm run native:build.`,
        },
      };
    }

    return new Promise((resolvePromise) => {
      const child = spawn(this.binary, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.on("error", (error) => {
        resolvePromise({ ok: false, error: { code: "native_spawn_failed", message: error.message } });
      });
      child.on("close", (code) => {
        try {
          resolvePromise(JSON.parse(stdout.trim()) as NativeResponse<T>);
        } catch {
          resolvePromise({
            ok: false,
            error: {
              code: "native_protocol_error",
              message: `Native worker exited ${code ?? "unknown"}: ${stderr.trim() || stdout.trim() || "no output"}`,
            },
          });
        }
      });
      child.stdin.end(stdin);
    });
  }

  start(args: string[]): ChildProcessWithoutNullStreams {
    return spawn(this.binary, args, { stdio: ["pipe", "pipe", "pipe"] });
  }
}
