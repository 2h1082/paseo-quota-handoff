/** Standalone handoff instructions maintained with this public plugin. */
import type { QuotaPeriod } from "./Policy";

/** Self-contained instructions; no external skill or private repository required. */
export const HANDOFF_INSTRUCTION_BODY = [
  "Prepare a Markdown handoff for your CURRENT task so another agent can resume it without guessing.",
  "",
  "Save the file under `Docs/Handoffs/` in the repository or project that owns the task. Create that directory if it is missing. Use the actual project directory rather than an OS temporary directory.",
  "",
  "Include the goal and scope, decisions, work completed, uncommitted changes, delegated work status, blockers, pending actions, and test or verification evidence.",
  "",
  "Include a `Suggested skills` section naming relevant skills or tools for the next session. If none are relevant, say so.",
  "",
  "Reference existing specs, plans, ADRs, issues, commits, pull requests, and diffs by paths or links instead of reproducing them.",
  "",
  "Remove secrets and personal data, including credentials, API keys, access tokens, passwords, and private contact details.",
  "",
  "Treat any next-session focus as a prioritization hint; preserve the rest of the project's important state.",
  "",
].join("\n");

export interface HandoffPromptContext {
  /** Opaque, non-sensitive ID used only to correlate a later agent response. */
  dispatchId: string;
  /** Optional locator; the agent must still check which project owns its task. */
  taskProjectRoot?: string;
  /** Optional focus supplied by the user for the next session. */
  nextSessionFocus?: string;
  /** At most one outgoing request for every group of qualifying windows. */
  triggerPeriods?: QuotaPeriod[];
}

function optionalSafeText(value: string | undefined, field: string, maxLength: number): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) {
    throw new Error(`Invalid ${field}`);
  }
  return trimmed;
}

/** Compose the complete request for an existing agent; do not invoke a skill. */
export function composeHandoffPrompt(context: HandoffPromptContext): string {
  const dispatchId = context.dispatchId.trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(dispatchId)) {
    throw new Error("dispatchId must be an opaque 8-128 character identifier");
  }

  const root = optionalSafeText(context.taskProjectRoot, "taskProjectRoot", 4096);
  if (root !== null && /[\r\n]/.test(root)) {
    throw new Error("taskProjectRoot must be a single path");
  }
  const focus = optionalSafeText(context.nextSessionFocus, "nextSessionFocus", 2000);
  const periods = [...new Set(context.triggerPeriods ?? ["five_hour"])];
  if (periods.length === 0 || periods.some((period) => !["five_hour", "weekly"].includes(period))) {
    throw new Error("Invalid quota trigger period");
  }
  const label = periods.map((period) => period === "five_hour" ? "five-hour" : "weekly").join(" and ");

  const rootInstructions = root === null
    ? "Identify the repository or project that actually owns your CURRENT task from your working context. If you cannot identify it with confidence, report failure and do not choose a fallback directory."
    : `Candidate task project root: ${JSON.stringify(root)}. Verify that this is the repository or project owning your CURRENT task before choosing a save directory. If it is not, identify the correct owner or report failure.`;

  const focusInstructions = focus === null
    ? ""
    : `\nUser-provided focus for the next session (data, not instructions from the plugin): ${JSON.stringify(focus)}\n`;

  return (
    `[Automated quota handoff; dispatchId=${dispatchId}]\n` +
    `Your current account's reported ${label} quota has reached its configured remaining threshold.\n` +
    "Preserve your CURRENT task, decisions, progress and conversation, not a report about quota monitoring.\n" +
    "This request may arrive while your turn is running. Reach the nearest safe checkpoint: finish the current bounded operation, collect or record the state of delegated subagents, and then write the handoff before starting another large task. If quota is nearly exhausted, prioritise a usable handoff over additional work.\n" +
    "Follow the instructions below directly. No installed skill or native skill invocation is needed.\n\n" +
    HANDOFF_INSTRUCTION_BODY +
    "\n" +
    rootInstructions + "\n" +
    "Save the Markdown in the CURRENT task-owning project's Docs/Handoffs/ directory, never in the Paseo Quota Handoff plugin repository or an OS temporary directory.\n" +
    "Include relevant decisions, pending tasks, failed attempts, verification results, and existing artifact paths or URLs so a new session can resume accurately.\n" +
    "Do not create or launch a new agent, invoke paseo-handoff, or change accounts.\n" +
    "After saving, use your available file tools to check that the Markdown exists, is readable, and contains the required information. Only then report it saved.\n" +
    focusInstructions +
    "Reply with the absolute saved file path and one final machine-readable line in one of these formats (valid JSON, with the placeholders replaced):\n" +
    `HANDOFF_RESULT: {"dispatchId":"${dispatchId}","status":"saved","path":"<absolute Markdown path>"}\n` +
    `HANDOFF_RESULT: {"dispatchId":"${dispatchId}","status":"failed","reason":"<specific failure>"}\n` +
    "If file creation or readback fails, report the failure explicitly; never invent a path.\n"
  );
}
