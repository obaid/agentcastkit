import { z } from "zod";

export const EditPlanVersion = "agentcastkit.edit-plan/v1" as const;
export const EditProfiles = ["tight", "balanced", "relaxed"] as const;
export type EditProfile = (typeof EditProfiles)[number];

export interface MediaVideoTrack {
  width: number;
  height: number;
  nominalFramesPerSecond: number;
}

export interface MediaInspection {
  path: string;
  durationSeconds: number;
  bytes: number;
  video?: MediaVideoTrack;
  audioTrackCount: number;
}

export interface ActivitySample {
  timeSeconds: number;
  differenceScore: number;
}

export interface MediaAnalysis extends MediaInspection {
  sampleFramesPerSecond: number;
  samples: ActivitySample[];
}

export const EditSegmentSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  sourceStartSeconds: z.number().min(0),
  sourceEndSeconds: z.number().positive(),
  playbackRate: z.number().min(0.25).max(8).default(1),
  reason: z.string().min(1).max(240),
});

export type EditSegment = z.infer<typeof EditSegmentSchema>;

export const EditPlanSchema = z.object({
  version: z.literal(EditPlanVersion),
  sourceJobId: z.string().uuid(),
  sourceArtifact: z.object({
    path: z.string().min(1),
    mimeType: z.literal("video/mp4"),
  }),
  sourceDurationSeconds: z.number().positive(),
  outputDurationSeconds: z.number().positive(),
  profile: z.enum(EditProfiles),
  segments: z.array(EditSegmentSchema).min(1).max(500),
  removedRanges: z.array(z.object({ startSeconds: z.number().min(0), endSeconds: z.number().positive() })),
  analysis: z.object({
    activityThreshold: z.number().min(0),
    activeSampleCount: z.number().int().min(0),
    sampleCount: z.number().int().min(0),
    hasAudio: z.boolean(),
    confidence: z.enum(["low", "medium", "high"]),
  }),
  warnings: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type EditPlan = z.infer<typeof EditPlanSchema>;

const profileSettings: Record<EditProfile, {
  threshold: number;
  quietGapSeconds: number;
  leadingHandleSeconds: number;
  trailingHandleSeconds: number;
  actionHandleSeconds: number;
  removeInternalSilence: boolean;
}> = {
  tight: {
    threshold: 0.004,
    quietGapSeconds: 2.5,
    leadingHandleSeconds: 0.55,
    trailingHandleSeconds: 1.1,
    actionHandleSeconds: 0.55,
    removeInternalSilence: true,
  },
  balanced: {
    threshold: 0.002,
    quietGapSeconds: 4,
    leadingHandleSeconds: 0.8,
    trailingHandleSeconds: 1.5,
    actionHandleSeconds: 0.8,
    removeInternalSilence: true,
  },
  relaxed: {
    threshold: 0.001,
    quietGapSeconds: Number.POSITIVE_INFINITY,
    leadingHandleSeconds: 1.2,
    trailingHandleSeconds: 2,
    actionHandleSeconds: 1.2,
    removeInternalSilence: false,
  },
};

export function buildEditPlan(sourceJobId: string, analysis: MediaAnalysis, profile: EditProfile): EditPlan {
  if (!Number.isFinite(analysis.durationSeconds) || analysis.durationSeconds <= 0) {
    throw new Error("The source video has no usable duration.");
  }
  const settings = profileSettings[profile];
  const samples = [...analysis.samples]
    .filter((sample) => Number.isFinite(sample.timeSeconds) && Number.isFinite(sample.differenceScore))
    .sort((left, right) => left.timeSeconds - right.timeSeconds);
  const activeTimes = samples
    .filter((sample) => sample.differenceScore >= settings.threshold)
    .map((sample) => clamp(sample.timeSeconds, 0, analysis.durationSeconds));
  const warnings: string[] = [];

  if (activeTimes.length === 0 || analysis.durationSeconds <= 3) {
    warnings.push("No reliable visual activity boundary was found, so the source is preserved in full.");
    return finalizePlan(sourceJobId, analysis, profile, settings.threshold, activeTimes.length, samples.length, [
      segment("keep_1", 0, analysis.durationSeconds, "Preserve the complete source because automatic trimming confidence is low."),
    ], warnings, "low");
  }

  const firstActivity = activeTimes[0] ?? 0;
  const lastActivity = activeTimes.at(-1) ?? analysis.durationSeconds;
  const contentStart = firstActivity - settings.leadingHandleSeconds > 0.5
    ? firstActivity - settings.leadingHandleSeconds
    : 0;
  const contentEnd = analysis.durationSeconds - (lastActivity + settings.trailingHandleSeconds) > 0.5
    ? lastActivity + settings.trailingHandleSeconds
    : analysis.durationSeconds;

  const ranges: Array<{ start: number; end: number; reason: string }> = [];
  let rangeStart = contentStart;
  let previousActivity = firstActivity;
  const allowInternalCuts = settings.removeInternalSilence && analysis.audioTrackCount === 0;

  if (settings.removeInternalSilence && analysis.audioTrackCount > 0) {
    warnings.push("Internal dead-air cuts were disabled because the source contains audio and 0.4 does not analyze speech or audio silence yet.");
  }

  if (allowInternalCuts) {
    for (const activityTime of activeTimes.slice(1)) {
      const quietDuration = activityTime - previousActivity;
      if (quietDuration > settings.quietGapSeconds + settings.actionHandleSeconds * 2) {
        ranges.push({
          start: rangeStart,
          end: previousActivity + settings.actionHandleSeconds,
          reason: "Keep visible activity and its outgoing action handle.",
        });
        rangeStart = activityTime - settings.actionHandleSeconds;
      }
      previousActivity = activityTime;
    }
  }
  ranges.push({ start: rangeStart, end: contentEnd, reason: "Keep visible activity and the completed end state." });

  const normalized = normalizeRanges(ranges, analysis.durationSeconds);
  const segments = normalized.map((range, index) => segment(`keep_${index + 1}`, range.start, range.end, range.reason));
  const confidence = activeTimes.length >= 4 ? "high" : activeTimes.length >= 2 ? "medium" : "low";
  if (confidence === "low") warnings.push("Only one reliable visual transition was detected; review the proposed trim before rendering.");

  return finalizePlan(sourceJobId, analysis, profile, settings.threshold, activeTimes.length, samples.length, segments, warnings, confidence);
}

export function validateEditSegments(segments: EditSegment[], sourceDurationSeconds: number): EditSegment[] {
  const parsed = z.array(EditSegmentSchema).min(1).max(500).parse(segments);
  let previousEnd = 0;
  for (const [index, item] of parsed.entries()) {
    if (item.sourceEndSeconds - item.sourceStartSeconds < 0.1) {
      throw new Error(`Segment ${index + 1} must be at least 0.1 seconds long.`);
    }
    if (item.sourceStartSeconds < previousEnd - 0.001) {
      throw new Error(`Segment ${index + 1} overlaps or precedes the prior segment.`);
    }
    if (item.sourceEndSeconds > sourceDurationSeconds + 0.001) {
      throw new Error(`Segment ${index + 1} exceeds the source duration.`);
    }
    previousEnd = item.sourceEndSeconds;
  }
  return parsed;
}

export function outputDuration(segments: EditSegment[]): number {
  return round(segments.reduce((total, item) => total + (item.sourceEndSeconds - item.sourceStartSeconds) / item.playbackRate, 0));
}

export function withEditSegments(plan: EditPlan, inputSegments: EditSegment[]): EditPlan {
  const segments = validateEditSegments(inputSegments, plan.sourceDurationSeconds);
  return EditPlanSchema.parse({
    ...plan,
    segments,
    outputDurationSeconds: outputDuration(segments),
    removedRanges: removedRanges(segments, plan.sourceDurationSeconds),
    updatedAt: new Date().toISOString(),
  });
}

function finalizePlan(
  sourceJobId: string,
  analysis: MediaAnalysis,
  profile: EditProfile,
  threshold: number,
  activeSampleCount: number,
  sampleCount: number,
  inputSegments: EditSegment[],
  warnings: string[],
  confidence: "low" | "medium" | "high",
): EditPlan {
  const segments = validateEditSegments(inputSegments, analysis.durationSeconds);
  const timestamp = new Date().toISOString();
  return EditPlanSchema.parse({
    version: EditPlanVersion,
    sourceJobId,
    sourceArtifact: { path: analysis.path, mimeType: "video/mp4" },
    sourceDurationSeconds: round(analysis.durationSeconds),
    outputDurationSeconds: outputDuration(segments),
    profile,
    segments,
    removedRanges: removedRanges(segments, analysis.durationSeconds),
    analysis: {
      activityThreshold: threshold,
      activeSampleCount,
      sampleCount,
      hasAudio: analysis.audioTrackCount > 0,
      confidence,
    },
    warnings,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function normalizeRanges(ranges: Array<{ start: number; end: number; reason: string }>, duration: number) {
  const normalized: typeof ranges = [];
  for (const range of ranges) {
    const start = round(clamp(range.start, 0, duration));
    const end = round(clamp(range.end, 0, duration));
    if (end - start < 0.1) continue;
    const previous = normalized.at(-1);
    if (previous && start <= previous.end + 0.05) {
      previous.end = Math.max(previous.end, end);
    } else {
      normalized.push({ start, end, reason: range.reason });
    }
  }
  return normalized;
}

function segment(id: string, start: number, end: number, reason: string): EditSegment {
  return { id, sourceStartSeconds: round(start), sourceEndSeconds: round(end), playbackRate: 1, reason };
}

function removedRanges(segments: EditSegment[], duration: number) {
  const ranges: Array<{ startSeconds: number; endSeconds: number }> = [];
  let cursor = 0;
  for (const item of segments) {
    if (item.sourceStartSeconds - cursor >= 0.1) ranges.push({ startSeconds: round(cursor), endSeconds: round(item.sourceStartSeconds) });
    cursor = item.sourceEndSeconds;
  }
  if (duration - cursor >= 0.1) ranges.push({ startSeconds: round(cursor), endSeconds: round(duration) });
  return ranges;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
