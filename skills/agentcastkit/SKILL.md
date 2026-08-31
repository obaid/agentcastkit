---
name: agentcastkit
description: Plan, rehearse, drive, record, post-edit, render, and review polished product demos with the AgentCastKit recorder MCP and its Cua Driver companion MCP. Use when the user asks to record a screen, app, browser flow, walkthrough, tutorial, product demo, or narrated demo.
metadata:
  agentcastkit-managed: "0.4.1"
---

# AgentCastKit production workflow

Produce a deliberate product story, not an unreviewed screen recording. Keep local capture available without activation. Treat managed TTS, premium or cloned voices, premium music, brand kits, hosted video, and team collaboration as paid cloud capabilities.

## Establish the brief

Infer what is safe and obvious, then resolve only material unknowns:

- the audience and outcome;
- the app, window, or display to capture;
- the intended duration and aspect ratio;
- whether the agent may take foreground control;
- sensitive data, irreversible actions, and required test accounts;
- whether the user wants silent local capture or paid narration/branding/hosting.

Never ask the user to repeat facts already available in the task or current UI.

## Preflight before recording

1. Call AgentCastKit `recorder_describe`, `product_features`, and `permissions_status`.
2. Use the Cua Driver MCP to inspect its permission state and current applications/windows. Follow Cua's snapshot-before-action invariant.
3. If an OS permission is missing, explain which signed app needs it and request only that permission. AgentCastKit Runner owns capture permission; CuaDriver owns Accessibility and its own Screen Recording permission.
4. Build a semantic plan and call `plan_validate` before acting. Use secret references rather than literal credentials.
5. Rehearse the flow with Cua Driver without recording. Prefer typed browser or native accessibility actions, then verify every important postcondition from fresh state.
6. Remove notifications, unrelated windows, personal tabs, autofill suggestions, and other sensitive material from the capture area.
7. Call `sources_list` after rehearsal and window arrangement. Source IDs can become stale when windows reopen.

Do not record during discovery or rehearsal. Do not turn on camera, microphone, system audio, or upload merely because the tool supports it.

## Compose for quality

- Show one clear story with a beginning, change, and verified result.
- Start from a clean, stable state and keep the target window at a consistent size.
- Prefer a single-app window capture when it contains the whole story; use display capture only when cross-app movement matters.
- Keep pointer movement purposeful. Before the first accessibility click, make one visible Cua cursor move so the agent cursor glides naturally in the recording.
- Pause briefly before and after meaningful actions so edits and narration have room.
- Avoid dead time, frantic typing, repeated clicks, and unexplained navigation.
- Use realistic non-sensitive sample data. Never expose tokens, passwords, private messages, or unrelated customer data.

## Record and drive

1. Summarize the exact source, duration, audio choices, and planned actions. Obtain explicit approval to record that source now.
2. Start `capture_start` with `userConfirmed: true`. Preserve the returned job ID.
3. Drive the approved plan through the Cua Driver MCP. Use fresh window/browser state before each action and verify the result before advancing.
4. Keep external side effects within the user's authorization. Never repeat a purchase, send, publish, delete, or other irreversible step just to improve a take.
5. Poll `job_get` until the recording completes. Cancel with `job_cancel` if the target becomes unsafe or the flow materially diverges.

The capture and control MCPs are independent processes. A recording job can remain active while Cua Driver performs the interaction. Requested filenames are suggestions: if one already exists, AgentCastKit preserves it and chooses a safe suffixed name for the new take.

## Post-produce the take

Treat post-production as the default continuation of a successful capture, not as a reason to make another take.

1. Call `artifact_inspect` with the completed capture job ID.
2. Call `edit_analyze` with the `balanced` profile, then poll its edit job with `job_get`.
3. Call `edit_plan_get`. Review its keep segments, removed ranges, confidence, and warnings against the intended story.
4. Use `edit_plan_update` only when the proposed ordered keep-list needs a specific correction. Segments can trim, cut, or change playback rate; the raw MP4 always remains untouched.
5. Call `render_start`, poll the render job, then call `artifact_inspect` on the completed render.
6. Review and return the rendered artifact as the primary result. Also retain the raw capture and edit job IDs so the work stays reversible.

In 0.4, automatic analysis is based on visual activity. It conservatively preserves internal pauses when a source contains audio because speech-aware editing is not available yet. It does not add zooms, captions, music, narration mixing, or semantic action cuts. Do not claim those treatments occurred.

Retake only when required content is missing, wrong, unsafe, obscured, or visually unusable. Fix ordinary dead time and pacing with the local edit plan. Never repeat an irreversible action for cosmetic improvement.

## Review before declaring success

Inspect the completed artifact and confirm:

- it opens and has non-zero duration;
- the intended source filled the frame;
- the first and last states are complete;
- cursor motion and action timing are legible;
- no secrets, notifications, or unrelated content appeared;
- every narrated claim is visibly supported.

If the final render is still poor, explain the concrete defect. Make at most one focused retake without asking again only when the original approval clearly covered another recording; otherwise ask before repeating. Never claim voice cloning, brand application, or hosting occurred unless those tools actually completed.

## Paid services

Call `product_features` before proposing cloud work. Activation is not required for local recording or Cua control. If a paid tool returns `activation_required` or `entitlement_required`, preserve the local result and explain the exact optional capability that needs a plan; do not describe the whole workflow as blocked.

Use provider-neutral AgentCastKit voice IDs only. Do not request or reveal provider keys or provider-native voice identifiers. Voice cloning requires explicit consent from the voice owner. Upload or hosted sharing requires explicit approval of the artifact and destination.
