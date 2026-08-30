import assert from "node:assert/strict";
import test from "node:test";
import { PlanVersion, validatePlan } from "../src/protocol.js";

function validPlan() {
  return {
    version: PlanVersion,
    title: "Create a project",
    objective: "Show a new user how to create their first project.",
    audience: "New customers",
    targetDurationSeconds: 45,
    source: { kind: "display" },
    driver: { kind: "cdp" },
    steps: [
      { id: "open_app", title: "Open the app", action: "navigate", url: "https://example.com", narration: "Open the application." },
      { id: "create", title: "Create", action: "click", target: "button[data-testid=create]", narration: "Create a new project." },
    ],
  };
}

test("accepts a privacy-safe plan", () => {
  const result = validatePlan(validPlan());
  assert.equal(result.valid, true);
  assert.equal(result.issues.length, 0);
  assert.equal(result.plan?.privacy.captureLiteralKeystrokes, false);
});

test("rejects duplicate step ids", () => {
  const plan = validPlan();
  plan.steps[1]!.id = "open_app";
  const result = validatePlan(plan);
  assert.equal(result.valid, false);
  assert.match(result.issues[0]?.message ?? "", /duplicate step id/);
});

test("requires secret references or values for typing", () => {
  const plan = validPlan();
  plan.steps.push({
    id: "type_email",
    title: "Type email",
    action: "type",
    target: "input[name=email]",
    narration: "Enter the account email.",
  });
  const result = validatePlan(plan);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.message.includes("value or secretRef")));
});
