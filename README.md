# AgentCastKit

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/agentcastkit.svg)](https://www.npmjs.com/package/agentcastkit)

AgentCastKit is an agent-first screen-demo system for macOS. An AI agent supplies a semantic demo plan through MCP; a local native worker owns ScreenCaptureKit and permission-sensitive work; durable jobs make long recordings and renders resumable and inspectable.

This repository is the first vertical slice. It can:

- expose a local MCP server over stdio;
- inspect capture permissions without prompting;
- request one named permission only with explicit confirmation;
- list recordable displays and windows;
- validate a privacy-aware semantic demo plan;
- start a bounded display/window recording and return a durable job ID;
- persist job state atomically and reconcile interrupted work after restart.

It does not yet drive a browser, capture editable separate tracks, call Resemble, edit a timeline, or render the final narrated demo. Those boundaries are intentionally explicit in `recorder_describe`.

This is the open-source local runtime. AgentCastKit's hosted activation, billing, protected orchestration recipes, licensed media, and provider integrations are maintained separately and are not part of this repository.

## Install with npx

On an Apple silicon Mac running macOS 15 or newer:

```bash
npx agentcastkit install
```

The installer verifies the bundled notarized Runner, installs it to `~/Applications`, opens the permission and activation experience, and configures detected Codex and Claude Code clients with the local AgentCastKit MCP server. It never downloads or executes an unsigned application.

Useful follow-up commands:

```bash
npx agentcastkit doctor
npx agentcastkit mcp-config
```

## macOS Runner app

Build the native GUI runner, embedded MCP runtime, Developer ID signature, and distributable ZIP:

```bash
npm run native:app
open "build/AgentCastKit Runner.app"
```

After configuring a `notarytool` Keychain profile named `AgentCastKit`, produce a fresh signed, notarized, and stapled release with:

```bash
npm run native:release
```

The runner checks and requests Screen Recording, microphone, and camera permissions; activates against the Laravel API while keeping the bearer token in Keychain; and copies a ready-to-paste MCP configuration for the bundled runtime. The same signed executable presents the GUI when opened normally and implements the native JSON protocol when an MCP host invokes it with command-line arguments.

## Run it

Requirements: macOS 15+, Xcode command-line tools, and Node.js 22+.

```bash
npm install
npm run native:build
npm run build
node dist/src/server.js
```

The last command is an MCP stdio process, so it waits for JSON-RPC on stdin rather than presenting a terminal UI.

For a development client configuration:

```json
{
  "mcpServers": {
    "agentcastkit": {
      "command": "node",
      "args": ["/Users/obaidahmed/Development/agentcastkit/dist/src/server.js"],
      "env": {
        "AGENTCASTKIT_CAPTURE_BIN": "/Users/obaidahmed/Development/agentcastkit/native/.build/debug/agentcastkit-capture"
      }
    }
  }
}
```

Call `permissions_status`, then `sources_list`. Permission prompts and recordings require explicit user confirmation. Captures default to:

`~/Library/Application Support/AgentCastKit/recordings/`

## Development

```bash
npm run check
```

The example plan is in `examples/browser-demo-plan.json`. The architecture and next milestones are in `docs/architecture.md`.

## Open-source boundary

Apache-2.0 covers the npm installer, MCP server and protocol, native macOS capture runner, documentation, and examples in this repository. It does not cover AgentCastKit cloud services, private prompts and production recipes, subscription systems, provider credentials, premium music, or hosted TTS/rendering services.

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Please report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/obaid/agentcastkit/security/advisories/new), not a public issue.
