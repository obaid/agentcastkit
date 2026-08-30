#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.1.0";
const APP_NAME = "AgentCastKit Runner.app";
const ASSET_NAME = "AgentCastKit-Runner-macOS-arm64.zip";
const ASSET_SHA256 = "4a12bbf4b8490fc6a96d6b0165b0b215077e1268906cc3a88c75d9a855ba8149";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface InstallOptions {
  target: string;
  configure: boolean;
  launch: boolean;
  dryRun: boolean;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function main(): Promise<void> {
  const [command = "help", ...arguments_] = process.argv.slice(2);

  switch (command) {
    case "install":
      await install(parseInstallOptions(arguments_));
      return;
    case "doctor":
      await doctor(parseInstallOptions(arguments_).target);
      return;
    case "mcp-config":
      printMCPConfiguration(parseInstallOptions(arguments_).target);
      return;
    case "--version":
    case "-v":
    case "version":
      console.log(VERSION);
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${command}. Run agentcastkit --help.`);
  }
}

function parseInstallOptions(arguments_: string[]): InstallOptions {
  let target = join(homedir(), "Applications");
  let configure = true;
  let launch = true;
  let dryRun = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--target") {
      const value = arguments_[index + 1];
      if (!value) throw new Error("--target requires a directory path.");
      target = resolve(value);
      index += 1;
    } else if (argument === "--skip-configure") {
      configure = false;
    } else if (argument === "--no-launch") {
      launch = false;
    } else if (argument === "--dry-run") {
      dryRun = true;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  return { target, configure, launch, dryRun };
}

async function install(options: InstallOptions): Promise<void> {
  console.log(`\nAgentCastKit ${VERSION}`);
  console.log("Agent-first product demos for macOS\n");
  assertSupportedPlatform();

  const assetPath = join(packageRoot, "assets", ASSET_NAME);
  await access(assetPath);
  const assetHash = createHash("sha256").update(await readFile(assetPath)).digest("hex");
  if (assetHash !== ASSET_SHA256) {
    throw new Error(`Runner integrity check failed. Expected ${ASSET_SHA256}, received ${assetHash}.`);
  }
  console.log("✓ Verified notarized Runner archive");

  if (options.dryRun) {
    console.log(`✓ Would install to ${join(options.target, APP_NAME)}`);
    console.log(`✓ Would configure detected MCP hosts: ${options.configure ? "yes" : "no"}`);
    console.log("\nDry run complete. No files or settings were changed.");
    return;
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "agentcastkit-install-"));
  const extractedApp = join(temporaryDirectory, APP_NAME);
  const targetApp = join(options.target, APP_NAME);
  const stagingApp = join(options.target, `.agentcastkit-installing-${process.pid}.app`);
  let backupApp: string | undefined;

  try {
    await run("/usr/bin/ditto", ["-x", "-k", assetPath, temporaryDirectory]);
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", extractedApp]);
    await run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=2", extractedApp]);
    console.log("✓ Apple signature and notarization accepted");

    await mkdir(options.target, { recursive: true });
    await rm(stagingApp, { recursive: true, force: true });
    await run("/usr/bin/ditto", [extractedApp, stagingApp]);

    if (await pathExists(targetApp)) {
      const backupDirectory = join(homedir(), "Library", "Application Support", "AgentCastKit", "backups");
      await mkdir(backupDirectory, { recursive: true });
      const timestamp = new Date().toISOString().replaceAll(":", "-");
      backupApp = join(backupDirectory, `AgentCastKit Runner ${timestamp}.app`);
      await rename(targetApp, backupApp);
    }

    try {
      await rename(stagingApp, targetApp);
    } catch (error) {
      if (backupApp && !(await pathExists(targetApp))) await rename(backupApp, targetApp);
      throw error;
    }
    console.log(`✓ Installed ${targetApp}`);

    if (options.launch) {
      await run("/usr/bin/open", [targetApp]);
      console.log("✓ Opened permission and activation setup");
    }

    if (options.configure) await configureMCPHosts(targetApp);

    console.log("\nAgentCastKit is installed.");
    console.log("Complete the permission checks in the Runner window, then ask your agent to list recording sources.");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
    await rm(stagingApp, { recursive: true, force: true });
  }
}

async function configureMCPHosts(appPath: string): Promise<void> {
  const configuration = mcpCommand(appPath);
  let foundHost = false;

  if (await commandExists("codex")) {
    foundHost = true;
    try {
      const existing = await run("codex", ["mcp", "get", "agentcastkit"], { allowFailure: true });
      if (existing.code === 0) {
        console.log("• Codex already has an AgentCastKit MCP entry; leaving it unchanged");
      } else {
        await run("codex", [
          "mcp", "add", "agentcastkit",
          "--env", `AGENTCASTKIT_CAPTURE_BIN=${configuration.nativeBinary}`,
          "--", "/usr/bin/env", "node", configuration.server,
        ]);
        console.log("✓ Configured AgentCastKit for Codex");
      }
    } catch (error) {
      console.warn(`! Could not configure Codex: ${errorMessage(error)}`);
    }
  }

  if (await commandExists("claude")) {
    foundHost = true;
    try {
      const existing = await run("claude", ["mcp", "get", "agentcastkit"], { allowFailure: true });
      if (existing.code === 0) {
        console.log("• Claude Code already has an AgentCastKit MCP entry; leaving it unchanged");
      } else {
        await run("claude", [
          "mcp", "add", "--scope", "user", "agentcastkit",
          "-e", `AGENTCASTKIT_CAPTURE_BIN=${configuration.nativeBinary}`,
          "--", "/usr/bin/env", "node", configuration.server,
        ]);
        console.log("✓ Configured AgentCastKit for Claude Code");
      }
    } catch (error) {
      console.warn(`! Could not configure Claude Code: ${errorMessage(error)}`);
    }
  }

  if (!foundHost) {
    console.log("• No supported MCP host CLI was detected");
    console.log("  Run `npx agentcastkit mcp-config` to print a manual configuration.");
  }
}

async function doctor(target: string): Promise<void> {
  assertSupportedPlatform();
  const appPath = join(target, APP_NAME);
  const configuration = mcpCommand(appPath);
  console.log(`AgentCastKit ${VERSION} doctor\n`);

  await access(configuration.nativeBinary);
  await access(configuration.server);
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  await run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=2", appPath]);
  const permissions = await run(configuration.nativeBinary, ["permissions", "status"]);

  console.log("✓ Runner installed");
  console.log("✓ Developer ID signature valid");
  console.log("✓ Apple notarization accepted");
  console.log(`✓ Native permissions: ${permissions.stdout.trim()}`);
}

function printMCPConfiguration(target: string): void {
  const configuration = mcpCommand(join(target, APP_NAME));
  console.log(JSON.stringify({
    mcpServers: {
      agentcastkit: {
        command: "/usr/bin/env",
        args: ["node", configuration.server],
        env: { AGENTCASTKIT_CAPTURE_BIN: configuration.nativeBinary },
      },
    },
  }, null, 2));
}

function mcpCommand(appPath: string): { nativeBinary: string; server: string } {
  return {
    nativeBinary: join(appPath, "Contents", "MacOS", "AgentCastKit Runner"),
    server: join(appPath, "Contents", "Resources", "mcp", "dist", "src", "server.js"),
  };
}

function assertSupportedPlatform(): void {
  if (process.platform !== "darwin") throw new Error("AgentCastKit Runner currently requires macOS.");
  if (process.arch !== "arm64") throw new Error("AgentCastKit 0.1.0 currently supports Apple silicon Macs (arm64).");
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) throw new Error("AgentCastKit requires Node.js 22 or newer.");
}

async function commandExists(command: string): Promise<boolean> {
  const result = await run("/usr/bin/env", ["which", command], { allowFailure: true });
  return result.code === 0;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function run(command: string, arguments_: string[], options: { allowFailure?: boolean } = {}): Promise<CommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      const result = { code: code ?? 1, stdout, stderr };
      if (result.code !== 0 && !options.allowFailure) {
        rejectPromise(new Error(`${command} failed: ${stderr.trim() || stdout.trim() || `exit ${result.code}`}`));
      } else {
        resolvePromise(result);
      }
    });
  });
}

function printHelp(): void {
  console.log(`AgentCastKit ${VERSION}\n\nUsage:\n  npx agentcastkit install [options]\n  npx agentcastkit doctor [--target <directory>]\n  npx agentcastkit mcp-config [--target <directory>]\n\nInstall options:\n  --target <directory>  Install somewhere other than ~/Applications\n  --skip-configure      Do not add MCP entries to detected agent hosts\n  --no-launch           Do not open the Runner after installation\n  --dry-run             Verify the package without changing the Mac\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
  const message = errorMessage(error);
  console.error(`\nAgentCastKit install failed: ${message}`);
  process.exitCode = 1;
});
