import assert from "node:assert/strict";
import test from "node:test";
import {
  HANDOFF_INSTRUCTION_BODY,
  composeHandoffPrompt,
} from "../server/HandoffPrompt.ts";

test("bundled handoff instructions are standalone Markdown guidance", () => {
  assert.ok(Buffer.byteLength(HANDOFF_INSTRUCTION_BODY, "utf8") > 400);
  assert.ok(HANDOFF_INSTRUCTION_BODY.endsWith("\n"));
  assert.doesNotMatch(HANDOFF_INSTRUCTION_BODY, /private repository|upstream commit|gitBlobSha1/i);
});

test("public handoff body covers task ownership, continuity, and redaction", () => {
  const body = HANDOFF_INSTRUCTION_BODY;
  assert.match(body, /CURRENT task/);
  assert.match(body, /Docs\/Handoffs\//);
  assert.match(body, /Create that directory if it is missing/);
  assert.match(body, /rather than an OS temporary directory/);
  assert.match(body, /`Suggested skills` section/);
  assert.match(body, /specs, plans, ADRs, issues, commits, pull requests, and diffs/);
  assert.match(body, /Remove secrets and personal data/);
  assert.match(body, /next-session focus/);
  assert.match(body, /delegated work status/);
});

test("composed prompt preserves standalone instructions and requires task ownership and path reporting", () => {
  const dispatchId = "test-handoff-0001";
  const prompt = composeHandoffPrompt({ dispatchId });
  assert.ok(prompt.includes(HANDOFF_INSTRUCTION_BODY));
  assert.match(prompt, /CURRENT task/);
  assert.match(prompt, /actually owns your CURRENT task/);
  assert.match(prompt, /never in the Paseo Quota Handoff plugin repository/);
  assert.match(prompt, /Do not create or launch a new agent/);
  assert.match(prompt, /No installed skill or native skill invocation is needed/);
  assert.match(prompt, /check that the Markdown exists, is readable/);
  assert.match(prompt, /pending tasks, failed attempts, verification results/);
  assert.match(prompt, /finish the current bounded operation/);
  assert.match(prompt, /delegated subagents/);
  assert.match(prompt, /HANDOFF_RESULT: \{"dispatchId":"test-handoff-0001","status":"saved","path":/);
  assert.match(prompt, /HANDOFF_RESULT: \{"dispatchId":"test-handoff-0001","status":"failed","reason":/);
  assert.doesNotMatch(prompt, /accountKey|sourceId|usedPercent/);
});

test("root and optional focus are contextual hints, with strict dispatch ID validation", () => {
  const prompt = composeHandoffPrompt({
    dispatchId: "handoff_01234567",
    taskProjectRoot: "D:\\Work\\Example",
    nextSessionFocus: "finish\nreview",
  });
  assert.match(prompt, /Candidate task project root: "D:\\\\Work\\\\Example"/);
  assert.match(prompt, /Verify that this is the repository or project owning your CURRENT task/);
  assert.ok(prompt.includes('"finish\\nreview"'));
  assert.throws(() => composeHandoffPrompt({ dispatchId: "bad id" }), /dispatchId/);
  assert.throws(() => composeHandoffPrompt({ dispatchId: "valid_id_123", taskProjectRoot: "first\nsecond" }), /taskProjectRoot/);
});

test("hand-off context distinguishes weekly-only and simultaneous threshold triggers", () => {
  const weekly = composeHandoffPrompt({ dispatchId: "weekly_12345678", triggerPeriods: ["weekly"] });
  assert.match(weekly, /reported weekly quota has reached/);
  const both = composeHandoffPrompt({ dispatchId: "both_12345678", triggerPeriods: ["five_hour", "weekly"] });
  assert.match(both, /five-hour and weekly quota/);
  assert.ok(both.includes(HANDOFF_INSTRUCTION_BODY));
  assert.throws(() => composeHandoffPrompt({ dispatchId: "badperiod_12345678", triggerPeriods: ["month"] }), /quota trigger period/);
});
