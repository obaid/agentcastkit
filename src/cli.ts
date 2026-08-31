#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.4.1";
const APP_NAME = "AgentCastKit Runner.app";
const ASSET_NAME = "AgentCastKit-Runner-macOS-arm64.zip";
const ASSET_SHA256 = "aae5066b55cf721c2b08cefa4681640545bd054f61abc1416d705bac5051285b";
const CUA_DRIVER_VERSION = "0.22.2";
const CUA_INSTALLER_URL = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}/_install-rust.sh`;
const CUA_INSTALLER_SHA256 = "f7483c2d081ed836ba1f9cbad943037907f098cf1be45f37a94d7a2d21303940";
const CUA_INSTALL_COMMON_URL = `https://raw.githubusercontent.com/trycua/cua/cua-driver-rs-v${CUA_DRIVER_VERSION}/libs/cua-driver/scripts/_install-common.sh`;
const CUA_INSTALL_COMMON_SHA256 = "5bc3aa010eb8667a099b582a9ada9a8f93001745b842cc7cf3cc6c472520cf29";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface InstallOptions {
  target: string;
  configure: boolean;
  launch: boolean;
  dryRun: boolean;
  installDriver: boolean;
  installSkills: boolean;
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
  let installDriver = true;
  let installSkills = true;

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
    } else if (argument === "--skip-driver") {
      installDriver = false;
    } else if (argument === "--skip-skills") {
      installSkills = false;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  return { target, configure, launch, dryRun, installDriver, installSkills };
}

async function install(options: InstallOptions): Promise<void> {
  console.log(`\nAgentCastKit ${VERSION}`);
  console.log("Agent-first product demos for macOS\n");
  assertSupportedPlatform();

  const assetPath = join(packageRoot, "assets", ASSET_NAME);
  const skillPath = join(packageRoot, "skills", "agentcastkit", "SKILL.md");
  await access(assetPath);
  await access(skillPath);
  const assetHash = createHash("sha256").update(await readFile(assetPath)).digest("hex");
  if (assetHash !== ASSET_SHA256) {
    throw new Error(`Runner integrity check failed. Expected ${ASSET_SHA256}, received ${assetHash}.`);
  }
  console.log("✓ Verified notarized Runner archive");

  if (options.dryRun) {
    console.log(`✓ Would install to ${join(options.target, APP_NAME)}`);
    console.log(`✓ Would install Cua Driver ${CUA_DRIVER_VERSION}: ${options.installDriver ? "yes" : "no"}`);
    console.log(`✓ Would install advanced agent skills: ${options.installSkills ? "yes" : "no"}`);
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

    let driverPath: string | undefined;
    if (options.installDriver) {
      driverPath = await installCuaDriver();
      console.log(`✓ Installed Cua Driver ${CUA_DRIVER_VERSION}`);
      const telemetry = await run(driverPath, ["telemetry", "disable"], { allowFailure: true });
      if (telemetry.code === 0) console.log("✓ Disabled Cua Driver telemetry for this installation");
    }

    if (options.installSkills) {
      await installAgentCastKitSkills();
      if (driverPath) {
        const cuaSkills = await run(driverPath, ["skills", "install"], { allowFailure: true });
        if (cuaSkills.code === 0) console.log("✓ Installed Cua Driver's native automation skill");
        else console.warn(`! Could not install Cua Driver's companion skill: ${cuaSkills.stderr.trim() || cuaSkills.stdout.trim()}`);
      }
    }

    if (options.launch) {
      await run("/usr/bin/open", [targetApp]);
      console.log("✓ Opened permission and activation setup");
      if (driverPath) {
        await run("/usr/bin/open", ["-n", "-g", "-a", "CuaDriver", "--args", "serve"], { allowFailure: true });
        console.log("✓ Opened Cua Driver automation permission setup");
      }
    }

    if (options.configure) await configureMCPHosts(targetApp, driverPath);

    console.log("\nAgentCastKit is installed.");
    console.log("Complete the AgentCastKit and Cua Driver permission checks, then ask your agent to plan and rehearse a recording.");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
    await rm(stagingApp, { recursive: true, force: true });
  }
}

async function installCuaDriver(): Promise<string> {
  const binDirectory = join(homedir(), "Library", "Application Support", "AgentCastKit", "bin");
  const driverPath = join(binDirectory, "cua-driver");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "agentcastkit-cua-"));
  const installerPath = join(temporaryDirectory, "_install-rust.sh");
  const commonPath = join(temporaryDirectory, "_install-common.sh");

  try {
    const [installer, common] = await Promise.all([
      downloadVerified(CUA_INSTALLER_URL, CUA_INSTALLER_SHA256, "Cua Driver installer"),
      downloadVerified(CUA_INSTALL_COMMON_URL, CUA_INSTALL_COMMON_SHA256, "Cua Driver install helper"),
    ]);

    await mkdir(binDirectory, { recursive: true, mode: 0o700 });
    await writeFile(installerPath, installer, { mode: 0o700 });
    await writeFile(commonPath, common, { mode: 0o600 });
    await run("/bin/bash", [installerPath, "--bin-dir", binDirectory, "--no-modify-path"], {
      env: {
        ...process.env,
        CUA_DRIVER_RS_VERSION: CUA_DRIVER_VERSION,
        CUA_DRIVER_RS_INSTALL_DIR: binDirectory,
        CUA_DRIVER_RS_NO_MODIFY_PATH: "1",
      },
    });
    const version = await run(driverPath, ["--version"]);
    if (!version.stdout.includes(CUA_DRIVER_VERSION)) {
      throw new Error(`Installed Cua Driver did not report expected version ${CUA_DRIVER_VERSION}.`);
    }
    return driverPath;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function downloadVerified(url: string, expectedHash: string, label: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${label} download failed with HTTP ${response.status}.`);
  const body = Buffer.from(await response.arrayBuffer());
  const hash = createHash("sha256").update(body).digest("hex");
  if (hash !== expectedHash) throw new Error(`${label} integrity check failed. Expected ${expectedHash}, received ${hash}.`);
  return body;
}

async function installAgentCastKitSkills(): Promise<void> {
  const source = join(packageRoot, "skills", "agentcastkit", "SKILL.md");
  const installations = [
    { name: "Codex", command: "codex", directory: join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "skills", "agentcastkit") },
    { name: "Claude Code", command: "claude", directory: join(homedir(), ".claude", "skills", "agentcastkit") },
  ];
  let installed = false;

  for (const host of installations) {
    const hostRoot = dirname(dirname(host.directory));
    if (!(await commandExists(host.command)) && !(await pathExists(hostRoot))) continue;
    const destination = join(host.directory, "SKILL.md");
    if (await pathExists(destination)) {
      const existing = await readFile(destination, "utf8");
      if (!existing.includes("agentcastkit-managed:")) {
        console.warn(`! ${host.name} already has an unmanaged AgentCastKit skill; leaving it unchanged`);
        continue;
      }
    }
    await mkdir(host.directory, { recursive: true, mode: 0o700 });
    const staging = join(host.directory, `.SKILL.md.installing-${process.pid}`);
    await writeFile(staging, await readFile(source), { mode: 0o600 });
    await rename(staging, destination);
    console.log(`✓ Installed advanced AgentCastKit skill for ${host.name}`);
    installed = true;
  }

  if (!installed) console.log("• No supported agent host was detected for skill installation");
}

async function configureMCPHosts(appPath: string, driverPath?: string): Promise<void> {
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
      if (driverPath) {
        const existingDriver = await run("codex", ["mcp", "get", "cua-driver"], { allowFailure: true });
        if (existingDriver.code === 0) {
          console.log("• Codex already has a Cua Driver MCP entry; leaving it unchanged");
        } else {
          await run("codex", ["mcp", "add", "cua-driver", "--", driverPath, "mcp"]);
          console.log("✓ Configured Cua Driver for Codex");
        }
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
      if (driverPath) {
        const existingDriver = await run("claude", ["mcp", "get", "cua-driver"], { allowFailure: true });
        const legacyDriver = await run("claude", ["mcp", "get", "cua-computer-use"], { allowFailure: true });
        if (existingDriver.code === 0 || legacyDriver.code === 0) {
          console.log("• Claude Code already has a Cua Driver MCP entry; leaving it unchanged");
        } else {
          const definition = JSON.stringify({ command: driverPath, args: ["mcp"] });
          await run("claude", ["mcp", "add-json", "--scope", "user", "cua-driver", definition]);
          console.log("✓ Configured Cua Driver for Claude Code");
        }
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
  const driverPath = managedCuaDriverPath();

  console.log("✓ Runner installed");
  console.log("✓ Developer ID signature valid");
  console.log("✓ Apple notarization accepted");
  console.log(`✓ Native permissions: ${permissions.stdout.trim()}`);
  await access(driverPath);
  const driverVersion = await run(driverPath, ["--version"]);
  const driverDoctor = await run(driverPath, ["doctor", "--json"]);
  const driverPermissions = await run(driverPath, ["permissions", "status", "--json"], { allowFailure: true });
  console.log(`✓ Cua Driver installed: ${driverVersion.stdout.trim()}`);
  console.log(`✓ Cua Driver health: ${compactJSON(driverDoctor.stdout)}`);
  const permissionText = driverPermissions.stdout || driverPermissions.stderr;
  const permissionState = parseJSON(permissionText);
  if (permissionState?.accessibility === true && permissionState?.screen_recording === true) {
    console.log(`✓ Cua Driver permissions: ${compactJSON(permissionText)}`);
  } else {
    console.log(`! Cua Driver permissions need setup or verification: ${compactJSON(permissionText)}`);
  }

  for (const [host, path] of Object.entries(agentSkillPaths())) {
    if (await pathExists(path)) console.log(`✓ Advanced AgentCastKit skill installed for ${host}`);
  }
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
      "cua-driver": {
        command: managedCuaDriverPath(),
        args: ["mcp"],
      },
    },
  }, null, 2));
}

function managedCuaDriverPath(): string {
  return join(homedir(), "Library", "Application Support", "AgentCastKit", "bin", "cua-driver");
}

function agentSkillPaths(): Record<string, string> {
  return {
    Codex: join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "skills", "agentcastkit", "SKILL.md"),
    "Claude Code": join(homedir(), ".claude", "skills", "agentcastkit", "SKILL.md"),
  };
}

function compactJSON(value: string): string {
  const parsed = parseJSON(value);
  return parsed ? JSON.stringify(parsed) : value.trim();
}

function parseJSON(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function mcpCommand(appPath: string): { nativeBinary: string; server: string } {
  return {
    nativeBinary: join(appPath, "Contents", "MacOS", "AgentCastKit Runner"),
    server: join(appPath, "Contents", "Resources", "mcp", "dist", "src", "server.js"),
  };
}

function assertSupportedPlatform(): void {
  if (process.platform !== "darwin") throw new Error("AgentCastKit Runner currently requires macOS.");
  if (process.arch !== "arm64") throw new Error("AgentCastKit 0.4.1 currently supports Apple silicon Macs (arm64).");
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

async function run(command: string, arguments_: string[], options: { allowFailure?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<CommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, { stdio: ["ignore", "pipe", "pipe"], env: options.env });
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
  console.log(`AgentCastKit ${VERSION}\n\nUsage:\n  npx agentcastkit install [options]\n  npx agentcastkit doctor [--target <directory>]\n  npx agentcastkit mcp-config [--target <directory>]\n\nInstall options:\n  --target <directory>  Install somewhere other than ~/Applications\n  --skip-configure      Do not add MCP entries to detected agent hosts\n  --skip-driver         Do not install the pinned Cua Driver companion\n  --skip-skills         Do not install AgentCastKit and Cua Driver skills\n  --no-launch           Do not open permission setup applications\n  --dry-run             Verify the package without changing the Mac\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
  const message = errorMessage(error);
  console.error(`\nAgentCastKit install failed: ${message}`);
  process.exitCode = 1;
});
