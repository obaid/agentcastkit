import { z } from "zod";

export const PlanVersion = "agentcastkit.demo-plan/v1" as const;

export const SourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("display"),
    id: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("window"),
    id: z.string().min(1).optional(),
    application: z.string().min(1).optional(),
    titleContains: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("area"),
    displayId: z.string().min(1),
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
    width: z.number().positive(),
    height: z.number().positive(),
  }),
]);

export const DriverSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cdp"),
    endpoint: z.string().url().optional(),
  }),
  z.object({
    kind: z.literal("webdriver"),
    endpoint: z.string().url(),
  }),
  z.object({
    kind: z.literal("accessibility"),
    bundleId: z.string().min(1),
  }),
  z.object({ kind: z.literal("manual") }),
]);

export const ActionSchema = z.enum([
  "navigate",
  "click",
  "type",
  "select",
  "scroll",
  "wait_for",
  "checkpoint",
]);

export const StepSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    title: z.string().min(1).max(120),
    action: ActionSchema,
    target: z.string().min(1).optional(),
    url: z.string().url().optional(),
    value: z.string().max(2_000).optional(),
    secretRef: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
    narration: z.string().min(1).max(2_000).optional(),
    expected: z.string().min(1).max(500).optional(),
    timeoutMs: z.number().int().min(250).max(120_000).default(15_000),
    sensitive: z.boolean().default(false),
  })
  .superRefine((step, context) => {
    if (step.action === "navigate" && !step.url) {
      context.addIssue({ code: "custom", message: "navigate steps require url", path: ["url"] });
    }
    if (["click", "type", "select", "wait_for"].includes(step.action) && !step.target) {
      context.addIssue({ code: "custom", message: `${step.action} steps require target`, path: ["target"] });
    }
    if (step.action === "type" && !step.value && !step.secretRef) {
      context.addIssue({ code: "custom", message: "type steps require value or secretRef", path: ["value"] });
    }
    if (step.value && step.secretRef) {
      context.addIssue({ code: "custom", message: "use value or secretRef, not both", path: ["secretRef"] });
    }
  });

export const DemoPlanSchema = z
  .object({
    version: z.literal(PlanVersion),
    title: z.string().min(1).max(160),
    objective: z.string().min(1).max(1_000),
    audience: z.string().min(1).max(500),
    targetDurationSeconds: z.number().int().min(10).max(3_600),
    source: SourceSchema,
    driver: DriverSchema,
    privacy: z
      .object({
        captureLiteralKeystrokes: z.literal(false).default(false),
        redactNotifications: z.boolean().default(true),
        redactPasswordFields: z.literal(true).default(true),
      })
      .default({
        captureLiteralKeystrokes: false,
        redactNotifications: true,
        redactPasswordFields: true,
      }),
    voiceover: z
      .object({
        enabled: z.boolean().default(true),
        provider: z.literal("resemble").default("resemble"),
        voiceRef: z.string().min(1).optional(),
        postNarration: z.literal(true).default(true),
      })
      .default({ enabled: true, provider: "resemble", postNarration: true }),
    steps: z.array(StepSchema).min(1).max(100),
  })
  .superRefine((plan, context) => {
    const seen = new Set<string>();
    for (const [index, step] of plan.steps.entries()) {
      if (seen.has(step.id)) {
        context.addIssue({ code: "custom", message: `duplicate step id: ${step.id}`, path: ["steps", index, "id"] });
      }
      seen.add(step.id);
    }
  });

export type DemoPlan = z.infer<typeof DemoPlanSchema>;

export interface PlanValidation {
  valid: boolean;
  plan?: DemoPlan;
  issues: Array<{ path: string; message: string }>;
  warnings: string[];
  estimatedNarrationSeconds: number;
}

export function validatePlan(input: unknown): PlanValidation {
  const result = DemoPlanSchema.safeParse(input);
  if (!result.success) {
    return {
      valid: false,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
      warnings: [],
      estimatedNarrationSeconds: 0,
    };
  }

  const narrationWords = result.data.steps.reduce(
    (total, step) => total + (step.narration?.trim().split(/\s+/).filter(Boolean).length ?? 0),
    0,
  );
  const estimatedNarrationSeconds = Math.ceil((narrationWords / 145) * 60);
  const warnings: string[] = [];

  if (result.data.driver.kind === "manual") {
    warnings.push("Manual driving cannot emit semantic selector and checkpoint telemetry.");
  }
  if (result.data.steps.some((step) => step.action === "type" && step.value && step.sensitive)) {
    warnings.push("A sensitive type step contains a literal value; prefer secretRef so the value never enters the plan or audit log.");
  }
  if (estimatedNarrationSeconds > result.data.targetDurationSeconds * 0.9) {
    warnings.push("Narration is likely too dense for the requested duration.");
  }

  return {
    valid: true,
    plan: result.data,
    issues: [],
    warnings,
    estimatedNarrationSeconds,
  };
}
