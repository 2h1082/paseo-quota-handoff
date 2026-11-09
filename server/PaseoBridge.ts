import { isAbsolute, resolve } from "node:path";
import type { AgentTarget } from "./Coordinator";

export type CliRunner = (args: string[], options?: { timeoutMs?: number; cliPath?: string }) => Promise<string>;

/** Distinguishes a definitely unsent message from an ambiguous transport failure. */
export class KnownUnsentError extends Error {
  constructor(message = "message was not sent") { super(message); }
}

/** A changed quota after inspect permits one bounded re-evaluation, never an old claim. */
export class QuotaChangedBeforeSendError extends KnownUnsentError {
  constructor() { super("current quota changed before send"); }
}

export class DeferredSendError extends KnownUnsentError {
  constructor() { super("agent turn in progress or state unknown"); }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function first(...values: unknown[]): string | undefined {
  for (const value of values) { const found = string(value); if (found) return found; }
  return undefined;
}

/** Paseo 0.15.3 native adapters with an active-turn steering path. The daemon may still fall back to interrupt. */
export function knownSteeringProvider(provider: string | undefined): boolean {
  const family = provider?.split("/")[0]?.toLowerCase();
  return family === "codex" || family === "claude" || family === "opencode" || family === "pi";
}

export function parseAgentListing(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload.map(object).filter((x) => !!first(x.id, object(x.agent).id));
  const list = object(payload).agents;
  return Array.isArray(list) ? list.map(object).filter((x) => !!first(x.id, object(x.agent).id)) : [];
}

function snapshot(entry: Record<string, unknown>, inspected: unknown): AgentTarget | null {
  const detail = object(inspected);
  const agent = { ...object(entry.agent), ...entry, ...object(detail.agent), ...detail };
  const configuration = object(agent.config);
  const workspace = object(agent.workspace);
  // `agent ls --json` uses lower-case keys while `agent inspect --json`
  // exposes display-oriented PascalCase keys on Paseo Desktop 0.15.3.
  const id = first(agent.Id, agent.id, configuration.id);
  const cwd = first(agent.Cwd, agent.cwd, configuration.cwd, workspace.path, agent.workingDirectory);
  if (!id || !cwd || !isAbsolute(cwd)) return null;

  const state = first(agent.Status, agent.state, agent.status, object(agent.status).state,
    object(agent.status).kind, object(agent.runtime).status, object(agent.runtime).state);
  const inactive = agent.Archived === true || agent.archived === true || agent.isArchived === true ||
    state === "archived" || state === "closed" || state === "error" ||
    state === "failed" || state === "stopped";
  // A missing or unrecognised state is treated as busy so we never interrupt a turn.
  // A boolean 'running: false' on an error/initializing snapshot is not an
  // authoritative idle turn. Only an explicit, recognized status is sendable.
  const idle = state === "idle" || state === "ready" || state === "waiting";
  const running = state === "running" || state === "busy" ||
    state === "working" || agent.isBusy === true || agent.running === true;
  const provider = first(agent.Provider, agent.provider, configuration.provider);
  return {
    id, cwd, isChild: !!first(agent.ParentAgentId, agent.parentAgentId, agent.parentId, object(agent.parent).id),
    isActive: !inactive, isBusy: running || !idle,
    // The inspect capabilities omit steer; use only Paseo's native adapters known to implement it.
    // A provider name alone cannot prove there is an active turn. Unknown,
    // initializing and inactive snapshots must not be steered.
    supportsSteer: ["running", "busy", "working"].includes(state ?? "") &&
      knownSteeringProvider(provider),
  };
}

/** Read-only fallback for receipts created before the task project root was stored. */
export async function inspectTaskProjectRoot(cli: CliRunner, agentId: string): Promise<string | null> {
  try {
    const details: unknown = JSON.parse(await cli(["agent", "inspect", agentId, "--json"]));
    return snapshot({ id: agentId }, details)?.cwd ?? null;
  } catch { return null; }
}

/** Conservative host-local directory. The usage source is always scoped by agent ID. */
export async function listAgentTargets(
  cli: CliRunner,
  options: { includeChildAgents: boolean; targetAgentIds: string[] } = {
    includeChildAgents: false, targetAgentIds: [],
  },
): Promise<AgentTarget[]> {
  // Background root agents are still independent agents. Include background
  // entries from Paseo and apply parentAgentId filtering separately below.
  const argv = ["agent", "ls", "--global", "--json", "--background"];
  const payload: unknown = JSON.parse(await cli(argv));
  const entries = parseAgentListing(payload);
  const targets: AgentTarget[] = [];
  for (const entry of entries) {
    const id = first(entry.id, object(entry.agent).id);
    if (!id) continue;
    if (options.targetAgentIds.length > 0 && !options.targetAgentIds.includes(id)) continue;
    if (["closed", "archived", "error"].includes(first(entry.status) ?? "")) continue;
    try {
      const detail: unknown = JSON.parse(await cli(["agent", "inspect", id, "--json"]));
      const target = snapshot(entry, detail);
      if (target?.isActive && (options.includeChildAgents || !target.isChild)) targets.push(target);
    } catch { /* Uninspectable agent is not eligible for automated messages. */ }
  }
  return targets;
}

export async function sendHandoff(cli: CliRunner, agentId: string, prompt: string,
  behavior: "steer" | "idle",
  canSend: (inspected: AgentTarget) => Promise<boolean | "quota-changed"> = async () => true,
  stillAuthorized: () => Promise<boolean | "quota-changed"> = async () => true): Promise<void> {
  let detail: unknown;
  try { detail = JSON.parse(await cli(["agent", "inspect", agentId, "--json"])); }
  catch { throw new KnownUnsentError("pre-send inspect failed"); }
  const inspected = snapshot({ id: agentId }, detail);
  if (!inspected || !inspected.isActive || !inspected.cwd ||
    (inspected.isBusy && (behavior !== "steer" || !inspected.supportsSteer))) {
    throw new DeferredSendError();
  }
  const permission = await canSend(inspected);
  if (permission === "quota-changed") throw new QuotaChangedBeforeSendError();
  if (!permission) throw new KnownUnsentError("pre-send authorization expired");
  // Settings and a forced quota refresh may take time. An agent that became
  // busy while the operator selected defer must not be steered as if still idle.
  // There is no atomic daemon send-if-idle API; narrow the last inspection gap.
  let newest: unknown;
  try { newest = JSON.parse(await cli(["agent", "inspect", agentId, "--json"])); }
  catch { throw new KnownUnsentError("last pre-send inspect failed"); }
  const finalAgent = snapshot({ id: agentId }, newest);
  const normalized = (path: string) => process.platform === "win32"
    ? resolve(path).toLowerCase() : resolve(path);
  if (!finalAgent || !finalAgent.isActive || normalized(finalAgent.cwd) !== normalized(inspected.cwd) ||
    (finalAgent.isBusy && (behavior !== "steer" || !finalAgent.supportsSteer))) {
    throw new DeferredSendError();
  }
  // Settings/reload/account may change while the second inspection is in
  // flight. The final account check runs AFTER that asynchronous inspection,
  // not before it. Paseo still lacks an atomic send-if-account primitive.
  const finalPermission = await stillAuthorized();
  if (finalPermission === "quota-changed") throw new QuotaChangedBeforeSendError();
  if (!finalPermission) throw new KnownUnsentError("monitor stopped before final send");
  // Match a normal Paseo user/agent message: steer the existing turn when supported.
  // Paseo may still interrupt if its provider adapter reports steering unavailable.
  const raw = await cli(["agent", "send", agentId, "--prompt", prompt,
    "--behavior", "steer", "--no-wait", "--json"], { timeoutMs: 30_000 });
  // A successful CLI exit means the daemon accepted the command. Interpret JSON
  // error envelopes defensively and never equate acceptance with a saved file.
  if (raw.trim().startsWith("{")) {
    const result = object(JSON.parse(raw));
    if (result.ok === false || result.success === false || result.error) {
      throw new Error("send failed");
    }
  }
}

export async function recentAgentOutput(cli: CliRunner, agentId: string, acceptedAt: number): Promise<string> {
  // Paseo 0.15.3 `--filter text` ALSO matches user_message, which includes our
  // outgoing HANDOFF_RESULT examples. assistant_message is an exact event type.
  return cli(["agent", "logs", agentId, "--tail", "100", "--since",
    new Date(Math.max(0, acceptedAt - 1_000)).toISOString(), "--filter", "assistant_message"], { timeoutMs: 15_000 });
}
