# AgentCastKit architecture and delivery path

## Product contract

An agent should be able to say what outcome it wants, negotiate a structured plan with the user, rehearse it, record scene-level takes, generate narration, assemble an edit, validate the result, and return both an editable project and a final artifact. Coordinate clicks are an implementation fallback, not the product API.

## Process boundary

```text
Claude / Codex / MCP host
          |
          | MCP over stdio (later localhost Streamable HTTP)
          v
TypeScript coordinator
  plans, approvals, durable jobs, audit, artifacts
          |
          | constrained JSON subprocess protocol
          v
Signed macOS capture worker
  TCC, ScreenCaptureKit, AVFoundation, clocks, local media
```

Premium services cross a separate cloud boundary. A privately maintained cloud service owns activation, installation identity, rotating credentials, subscription entitlements, usage reservations, protected orchestration recipes, managed TTS, premium or cloned voices, brand kits, hosted video, team collaboration, and licensed music delivery. Raw screen media remains local unless the user separately approves an upload. Recording, Cua Driver automation, planning, validation, durable jobs, and local artifacts do not require activation.

GUI control is a companion MCP boundary. `npx agentcastkit install` pins and verifies Cua Driver, installs its stable signed `CuaDriver.app` identity, registers its MCP beside AgentCastKit, and installs a coordinating AgentCastKit skill. AgentCastKit owns capture jobs; Cua Driver owns snapshot-bound GUI action and verification. Those independent processes let control continue while a bounded recording job is active.

```text
Agent / MCP host
  | voice_library_list (stable AgentCastKit voiceId)
  | voiceover_synthesize
  v
Signed Runner broker
  | installation identity + activation token from Keychain
  v
Private Laravel API
  | entitlement check -> usage reservation -> normalized catalog
  v
TextToSpeechProvider contract
  | today: Resemble AI     tomorrow: any compatible provider
  v
Audio bytes return through Laravel and are written to a local artifact
```

Provider credentials and provider-native voice identifiers terminate inside the private backend. The MCP surface exposes normalized metadata and stable AgentCastKit voice IDs, so replacing or mixing providers does not change the agent contract. Preview URLs are opt-in to keep a full marketplace query from consuming unnecessary agent context.

The capture worker never owns product planning or credentials. The coordinator never handles `CMSampleBuffer` objects. Browser drivers eventually emit semantic events onto the same monotonic clock as captured media.

## Milestone 0 — implemented here

- MCP stdio server
- privacy-safe demo-plan schema
- durable atomic job records
- permission status/request boundary
- display/window enumeration
- bounded proof-of-life MP4 capture via `SCRecordingOutput`

The proof-of-life file is deliberately not the final project format. `SCRecordingOutput` produces a convenient composite MP4 but cannot provide Prequel-style editable screen, microphone, system-audio, camera, cursor, and action tracks.

## Milestone 1 — capture foundation

- replace `SCRecordingOutput` with explicit ScreenCaptureKit outputs and AVAssetWriter/VideoToolbox encoders;
- write crash-safe two-second fragments and a manifest before consolidation;
- maintain a shared host-time clock across screen, audio, microphone, and camera;
- sample cursor shape/position separately and record click geometry without literal keys;
- add an agent-visible preview/checkpoint resource;
- sign and package a per-user launch agent.

Exit criterion: a 30-minute recording survives coordinator restart, has synchronized editable tracks, and never captures secrets by default.

## Milestone 2 — rehearsal and semantic driving

- CDP/Playwright adapter first, WebDriver second, macOS Accessibility fallback third;
- plan compilation from semantic steps into driver actions;
- checkpoint screenshots and DOM/accessibility assertions;
- per-step retries and scene boundaries;
- privacy masks derived from password fields and plan annotations;
- approval artifact showing source, steps, sensitive actions, narration, and estimated duration.

Exit criterion: the agent can rehearse a five-step browser workflow, explain exactly what it will record, and repair one failed step without restarting the whole run.

## Milestone 3 — project, narration, and rendering

- immutable source takes plus a non-destructive source-time edit list;
- declarative render plan shared by preview and export;
- automatic zooms anchored to semantic target rectangles;
- managed voice clips generated per scene after capture;
- local speech-to-text word timing for captions and narration QA;
- native Metal renderer and VideoToolbox encoder;
- background music, ducking, cursor treatment, captions, and 16:9/9:16 reframing.

Exit criterion: one approved plan yields an editable project package and deterministic 1080p MP4; regenerating a sentence only invalidates its scene.

## Milestone 4 — trust and operations

- localhost Streamable HTTP with origin checks and audience-bound tokens;
- secret handles resolved only inside the driver adapter;
- capability-scoped approvals for record, microphone, TTS upload, and publishing;
- artifact retention policy, audit log, and privacy review screen;
- visual/audio QA and prior-release checkpoint comparison;
- Drive, R2, and share-link publishing as separate connectors.

## Proposed package split after the vertical slice

```text
apps/mcp-server          MCP transport and high-level tools
apps/review              optional local plan/review UI
packages/protocol        plans, events, jobs, project schemas
packages/coordinator     durable workflow state machine
packages/driver-cdp      Playwright/CDP semantic driver
packages/voice          provider-neutral scene-level TTS client
native/capture           signed capture daemon
native/render            Metal/VideoToolbox compositor
```

Keep the repository compact until Milestone 1 forces those boundaries. Prematurely creating empty services would hide the critical work: clocks, recovery, privacy, and deterministic project semantics.
