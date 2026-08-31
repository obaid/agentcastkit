import assert from "node:assert/strict";
import test from "node:test";
import { buildEditPlan, outputDuration, validateEditSegments, type MediaAnalysis } from "../src/editing.js";

function analysis(overrides: Partial<MediaAnalysis> = {}): MediaAnalysis {
  return {
    path: "/tmp/source.mp4",
    durationSeconds: 60,
    bytes: 1_000,
    video: { width: 1920, height: 1080, nominalFramesPerSecond: 30 },
    audioTrackCount: 0,
    sampleFramesPerSecond: 2,
    samples: [
      { timeSeconds: 28, differenceScore: 0.08 },
      { timeSeconds: 30, differenceScore: 0.04 },
      { timeSeconds: 35, differenceScore: 0.06 },
      { timeSeconds: 42, differenceScore: 0.07 },
    ],
    ...overrides,
  };
}

test("balanced edit removes long leading dead time and preserves the end state", () => {
  const plan = buildEditPlan("454a52db-e9d5-43cf-bd4e-a3d732c7b6af", analysis(), "balanced");
  assert.equal(plan.segments[0]?.sourceStartSeconds, 27.2);
  assert.equal(plan.segments.at(-1)?.sourceEndSeconds, 43.5);
  assert.ok(plan.outputDurationSeconds < plan.sourceDurationSeconds);
  assert.deepEqual(plan.removedRanges, [
    { startSeconds: 0, endSeconds: 27.2 },
    { startSeconds: 35.8, endSeconds: 41.2 },
    { startSeconds: 43.5, endSeconds: 60 },
  ]);
});

test("balanced edit keeps audio-bearing internal pauses", () => {
  const plan = buildEditPlan("454a52db-e9d5-43cf-bd4e-a3d732c7b6af", analysis({
    audioTrackCount: 1,
    samples: [
      { timeSeconds: 2, differenceScore: 0.08 },
      { timeSeconds: 20, differenceScore: 0.07 },
      { timeSeconds: 50, differenceScore: 0.06 },
    ],
  }), "balanced");
  assert.equal(plan.segments.length, 1);
  assert.match(plan.warnings[0] ?? "", /audio/);
});

test("no detected activity preserves the complete source", () => {
  const plan = buildEditPlan("454a52db-e9d5-43cf-bd4e-a3d732c7b6af", analysis({ samples: [] }), "tight");
  assert.equal(plan.outputDurationSeconds, 60);
  assert.equal(plan.analysis.confidence, "low");
});

test("custom segments reject overlap and calculate playback rates", () => {
  assert.throws(() => validateEditSegments([
    { id: "one", sourceStartSeconds: 0, sourceEndSeconds: 5, playbackRate: 1, reason: "First" },
    { id: "two", sourceStartSeconds: 4, sourceEndSeconds: 8, playbackRate: 1, reason: "Second" },
  ], 10), /overlaps/);
  assert.equal(outputDuration([
    { id: "one", sourceStartSeconds: 0, sourceEndSeconds: 4, playbackRate: 2, reason: "Accelerated" },
  ]), 2);
});
