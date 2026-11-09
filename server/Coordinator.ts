import { randomUUID } from "node:crypto";
import { composeHandoffPrompt } from "./HandoffPrompt";
import {
  QUOTA_PERIODS, evaluateQuota, isValidConfig, ruleFor,
  type MonitorConfig, type QuotaPeriod, type QuotaSample, type QuotaWindows,
} from "./Policy";
import { DispatchStoreLockedError, dispatchKey, type DispatchReceipt, type FileDispatchStore } from "./StateStore";
import { extractHandoffResult, verifyHandoffFile } from "./ArtifactVerifier";
import { DeferredSendError, KnownUnsentError, QuotaChangedBeforeSendError } from "./PaseoBridge";

export interface AgentTarget {
  id: string;
  cwd: string;
  isChild: boolean;
  isActive: boolean;
  isBusy: boolean;
  /** Explicitly proven by provider integration, false if unknown. */
  supportsSteer: boolean;
}

export type AgentStatus = "unknown" | "skipped" | "candidate" | "deferred" | "claimed" | "accepted" | "verified" | "uncertain";

export interface PeriodDiagnostic {
  period: QuotaPeriod;
  status: "available" | "unknown" | "error" | "disabled";
  remainingPercent?: number;
  thresholdPercent: number;
  fetchedAt?: number;
  resetAt?: string;
  candidate: boolean;
  reason?: string;
}

export interface AgentDiagnostic {
  agentId: string;
  status: AgentStatus;
  periods?: PeriodDiagnostic[];
  lastFetchedAt?: number;
  remainingPercent?: number;
  lastAttemptAt?: number;
  documentPath?: string;
  lastDispatchStage?: DispatchReceipt["stage"];
  lastVerifiedDocument?: string;
  reason?: string;
}

export interface CoordinatorPorts {
  hostId: string;
  now(): number;
  settings(): Promise<MonitorConfig | null>;
  agents(): Promise<AgentTarget[]>;
  quota(agentId: string, refresh: boolean): Promise<QuotaWindows>;
  /** Throws on unknown acceptance; neither success nor failure proves a file exists. */
  send(agentId: string, prompt: string, behavior: "steer" | "idle",
    claimedWindows: Array<Extract<QuotaSample, { status: "available" }>>, taskProjectRoot: string): Promise<void>;
  /** Only assistant output after the given request; user requests must be excluded. */
  output(agentId: string, acceptedAt: number): Promise<string>;
  /** Optional best-effort read-only lookup for legacy receipts with no stored task root. */
  agentTaskProjectRoot?(agentId: string): Promise<string | null>;
  store: FileDispatchStore;
  verifyFile?(cwd: string, path: string, acceptedAt: number): Promise<string | null>;
}

function safeReason(reason: string): string {
  const known = new Set([
    "monitor-off", "period-disabled", "invalid-settings", "invalid-or-stale-window", "above-threshold",
    "already-sent", "turn-in-progress", "no-project-root", "account-or-window-changed",
    "verification-pending", "agent-reported-save-failure", "dispatch-uncertain",
    "quota-unavailable", "cli-failed", "no-valid-agent", "settings-changed", "unexpected-error", "store-locked",
  ]);
  return known.has(reason) ? reason : "quota-unavailable";
}

function periodDiagnostics(windows: QuotaWindows, config: MonitorConfig, now: number): PeriodDiagnostic[] {
  return QUOTA_PERIODS.map((period) => {
    const sample = windows[period];
    const rule = ruleFor(config, period);
    const decision = evaluateQuota(sample, config, now);
    return {
      period, status: rule.enabled ? sample.status : "disabled",
      thresholdPercent: rule.remainingThresholdPercent,
      candidate: decision.kind === "eligible",
      ...(sample.fetchedAt !== undefined ? { fetchedAt: sample.fetchedAt } : {}),
      ...(sample.status === "available" ? { remainingPercent: sample.remainingPercent } : {}),
      ...(sample.status === "available" ? { resetAt: sample.resetAt } : {}),
      ...(decision.kind !== "eligible" ? { reason: safeReason(decision.reason) } : {}),
    };
  });
}

type Available = Extract<QuotaSample, { status: "available" }>;

/** Serial scan-to-send orchestrator. One instance and one writer per daemon/plugin process. */
export class QuotaCoordinator {
  private readonly status = new Map<string, AgentDiagnostic>();
  private scanning = false;
  private reconciling = false;
  private reconcileCursor = 0;
  private stopped = false;
  private generation = 0;
  private lastScanAt: number | null = null;
  private scanError: string | null = null;

  constructor(private readonly ports: CoordinatorPorts) {}

  diagnostics(): { lastScanAt: number | null; busy: boolean; scanError: string | null; agents: AgentDiagnostic[] } {
    return {
      lastScanAt: this.lastScanAt, busy: this.scanning, scanError: this.scanError,
      agents: [...this.status.values()].sort((a, b) => a.agentId.localeCompare(b.agentId)),
    };
  }

  invalidate(): void { this.generation += 1; }
  stop(): void { this.stopped = true; this.invalidate(); }

  private async permitted(generation: number): Promise<boolean> {
    if (this.stopped || generation !== this.generation) return false;
    const config = await this.ports.settings();
    return !!config && config.enabled && isValidConfig(config) &&
      generation === this.generation && !this.stopped;
  }

  private set(agentId: string, values: Omit<AgentDiagnostic, "agentId">): void {
    this.status.set(agentId, { agentId, ...values });
  }

  async scan(): Promise<void> {
    if (this.scanning || this.stopped) return;
    this.scanning = true;
    const generation = this.generation;
    try {
      const config = await this.ports.settings();
      if (!config || !config.enabled || !isValidConfig(config)) return;
      const agents = await this.ports.agents();
      this.scanError = null;
      for (const agent of agents) {
        if (!await this.permitted(generation)) break;
        if (!agent.isActive || (agent.isChild && !config.includeChildAgents) ||
          (config.targetAgentIds.length > 0 && !config.targetAgentIds.includes(agent.id))) continue;
        try {
          await this.scanAgent(agent, config, generation);
        } catch (error) {
          this.set(agent.id, { status: "unknown", reason: error instanceof DispatchStoreLockedError
            ? "store-locked" : "unexpected-error" });
        }
      }
      this.lastScanAt = this.ports.now();
    } catch {
      this.scanError = "quota-unavailable";
      this.lastScanAt = this.ports.now();
    } finally { this.scanning = false; }
  }

  /** Continue artifact readback independently of quota monitoring and the agent's active status. */
  async reconcileOutstanding(): Promise<void> {
    if (this.reconciling || this.stopped) return;
    this.reconciling = true;
    try {
      // A timed-out send can still be accepted by the daemon. Read-only proof is
      // safe even for uncertain receipts; never resend just to resolve ambiguity.
      const pending = (await this.ports.store.list()).filter((receipt) =>
        receipt.stage === "accepted" || receipt.stage === "uncertain");
      if (pending.length === 0) { this.reconcileCursor = 0; return; }
      const start = this.reconcileCursor % pending.length;
      const maxPerCycle = 3;
      const selected = Array.from({ length: Math.min(maxPerCycle, pending.length) }, (_, i) =>
        pending[(start + i) % pending.length]);
      this.reconcileCursor = (start + selected.length) % pending.length;
      // A blocked/slow output lookup must not stall quota scanning or all
      // other handoff verifications. The CLI itself has a timeout.
      await Promise.all(selected.map(async (receipt) => {
        if (this.stopped) return;
        try {
          const root = receipt.taskProjectRoot ?? await this.ports.agentTaskProjectRoot?.(receipt.agentId);
          if (!root) return;
          if (!receipt.taskProjectRoot) {
            // Root recovery only attaches metadata. It must never upgrade an
            // uncertain transport to accepted without delivery evidence.
            await this.ports.store.update(receipt.key, receipt.stage, { taskProjectRoot: root });
          }
          await this.reconcile({ id: receipt.agentId, cwd: root }, receipt);
        } catch {
          // Leave the accepted receipt intact for the next verification attempt.
        }
      }));
      // Parallel readbacks finish in arbitrary order. Present the newest
      // dispatch for each agent, not whichever historical receipt finishes last.
      const newest = new Map<string, DispatchReceipt>();
      for (const receipt of await this.ports.store.list()) {
        const before = newest.get(receipt.agentId);
        if (!before || receipt.claimedAt >= before.claimedAt) newest.set(receipt.agentId, receipt);
      }
      for (const agentId of new Set(selected.map((receipt) => receipt.agentId))) {
        const latest = newest.get(agentId);
        if (!latest) continue;
        const previous = this.status.get(agentId);
        this.status.set(agentId, { ...previous, agentId,
          status: latest.stage === "claimed" ? "uncertain" : latest.stage,
          lastAttemptAt: latest.claimedAt, lastDispatchStage: latest.stage,
          documentPath: latest.documentPath,
          reason: latest.stage === "claimed" ? "dispatch-uncertain" :
            latest.stage === "accepted" ? "verification-pending" : latest.reason,
        });
      }
    } catch (error) {
      // The timer and turn hook launch this task without awaiting it. Preserve
      // a controlled diagnostic instead of leaving an unhandled rejection.
      this.scanError = error instanceof DispatchStoreLockedError ? "store-locked" : "unexpected-error";
    } finally { this.reconciling = false; }
  }

  private keyFor(agentId: string, quota: Available): string {
    return dispatchKey(this.ports.hostId, agentId, quota.sourceId,
      quota.accountKey, quota.windowId, quota.resetAt, quota.period);
  }

  private async priorClaim(agentId: string, quota: Available): Promise<DispatchReceipt | undefined> {
    const current = await this.ports.store.get(this.keyFor(agentId, quota));
    if (current) return current;
    if (quota.period !== "five_hour") return undefined;
    // Keep pre-release five-hour dispatch receipts valid across an upgrade.
    // No pre-release WEEKLY receipts existed; a generic provider ID and aligned
    // reset must never make a five-hour legacy key suppress the new week.
    const legacy = dispatchKey(this.ports.hostId, agentId, quota.sourceId,
      quota.accountKey, quota.windowId, quota.resetAt);
    return this.ports.store.get(legacy);
  }

  /**
   * A period can recover above its threshold without invalidating another
   * eligible period. A changed *account* is different: never send a request
   * based on readings from the previous account.
   */
  private stableEligible(
    previous: Available[], windows: QuotaWindows, config: MonitorConfig,
  ): { accountChanged: boolean; eligible: Available[] } {
    const eligible: Available[] = [];
    const original = previous[0];
    for (const before of previous) {
      const after = windows[before.period];
      if (after.status === "available" &&
        (after.sourceId !== before.sourceId || after.accountKey !== before.accountKey)) {
        return { accountChanged: true, eligible: [] };
      }
      const decision = evaluateQuota(after, config, this.ports.now());
      // A reset can open a fresh qualifying window between inspections. It
      // belongs to this dispatch when the actual account is still the same.
      // Requiring the stale window key here splits a simultaneous trigger.
      if (decision.kind === "eligible") {
        eligible.push(decision.quota);
      }
    }
    // A window which crossed its threshold during the fresh read belongs in
    // the same dispatch. Without this, the next scan would send a duplicate
    // handoff although both limits already qualified at the send boundary.
    for (const period of QUOTA_PERIODS) {
      if (previous.some((quota) => quota.period === period)) continue;
      const decision = evaluateQuota(windows[period], config, this.ports.now());
      if (decision.kind !== "eligible") continue;
      if (decision.quota.sourceId !== original.sourceId ||
        decision.quota.accountKey !== original.accountKey) {
        return { accountChanged: true, eligible: [] };
      }
      eligible.push(decision.quota);
    }
    if (eligible.length > 0 && eligible.some((quota) =>
      quota.sourceId !== eligible[0].sourceId || quota.accountKey !== eligible[0].accountKey)) {
      return { accountChanged: true, eligible: [] };
    }
    return { accountChanged: false, eligible };
  }

  private async scanAgent(agent: AgentTarget, config: MonitorConfig, generation: number, quotaRetryBudget = 1): Promise<void> {
    const now = this.ports.now();
    const observed = await this.ports.quota(agent.id, false);
    const periods = periodDiagnostics(observed, config, now);
    const observedEligible = QUOTA_PERIODS.flatMap((period) => {
      const decision = evaluateQuota(observed[period], config, now);
      return decision.kind === "eligible" ? [decision.quota] : [];
    });
    const primary = observedEligible[0];
    const base = {
      periods,
      ...(primary ? { lastFetchedAt: primary.fetchedAt, remainingPercent: primary.remainingPercent } : {}),
    };
    if (observedEligible.length === 0) {
      const firstUnknown = periods.find((entry) => entry.status === "unknown" || entry.status === "error");
      this.set(agent.id, { ...base, status: firstUnknown ? "unknown" : "skipped",
        reason: firstUnknown ? safeReason(firstUnknown.reason ?? "quota-unavailable") : "above-threshold" });
      return;
    }
    if (config.dryRun) {
      this.set(agent.id, { ...base, status: "candidate", reason: "verification-pending" });
      return;
    }

    const refreshed = await this.ports.quota(agent.id, true);
    const refreshedStable = this.stableEligible(observedEligible, refreshed, config);
    if (refreshedStable.accountChanged || refreshedStable.eligible.length === 0) {
      this.set(agent.id, { ...base, status: "unknown", reason: "account-or-window-changed" });
      return;
    }
    if (!agent.cwd) {
      this.set(agent.id, { ...base, status: "unknown", reason: "no-project-root" });
      return;
    }
    // A single agent cannot safely dispatch for two different current accounts.
    const refreshedEligible = refreshedStable.eligible;

    const newWindows: Array<{ quota: Available; key: string }> = [];
    const previouslyClaimed: DispatchReceipt[] = [];
    for (const quota of refreshedEligible) {
      const key = this.keyFor(agent.id, quota);
      const existing = await this.priorClaim(agent.id, quota);
      if (existing) previouslyClaimed.push(existing);
      else newWindows.push({ quota, key });
    }
    if (newWindows.length === 0) {
      const receipt = previouslyClaimed.sort((a, b) => b.claimedAt - a.claimedAt)[0];
      if (receipt) {
        // Artifact logs may take many seconds to retrieve. Leave receipt
        // verification to its own bounded loop, never block quota scanning.
        this.set(agent.id, { ...base,
          status: receipt.stage === "claimed" ? "uncertain" : receipt.stage,
          lastAttemptAt: receipt.claimedAt,
          documentPath: receipt.documentPath,
          lastDispatchStage: receipt.stage,
          reason: receipt.stage === "claimed" ? "dispatch-uncertain"
            : receipt.stage === "accepted" ? "verification-pending" : receipt.reason,
        });
      }
      return;
    }
    if (agent.isBusy && (config.activeTurnMode !== "steer" || !agent.supportsSteer)) {
      this.set(agent.id, { ...base, status: "deferred", reason: "turn-in-progress" });
      return;
    }
    if (!await this.permitted(generation)) return;
    // Second forced refresh closes the account-switch gap before durable claim.
    const final = await this.ports.quota(agent.id, true);
    const finalStable = this.stableEligible(refreshedEligible, final, config);
    if (finalStable.accountChanged || finalStable.eligible.length === 0) {
      this.set(agent.id, { ...base, status: "unknown", reason: "account-or-window-changed" });
      return;
    }
    const finalNewWindows: Array<{ quota: Available; key: string }> = [];
    for (const quota of finalStable.eligible) {
      const key = this.keyFor(agent.id, quota);
      if (!(await this.priorClaim(agent.id, quota))) finalNewWindows.push({ quota, key });
    }
    if (finalNewWindows.length === 0) {
      this.set(agent.id, { ...base, status: "skipped", reason: "above-threshold" });
      return;
    }
    if (!await this.permitted(generation)) return;

    let dispatchWindows = finalNewWindows;
    let claimed = false;
    let claimedAt = this.ports.now();
    let prompt = "";
    // Another plugin process may claim one of two eligible windows while we
    // prepare the group. Retry once with a fresh report and only uncovered keys.
    // Never send based on stale period/account identity after a conflicting claim.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!await this.permitted(generation)) return;
      const [selected, ...alsoTriggered] = dispatchWindows;
      if (!selected) {
        this.set(agent.id, { ...base, status: "claimed", reason: "already-sent" });
        return;
      }
      const dispatchId = randomUUID();
      claimedAt = this.ports.now();
      try {
        prompt = composeHandoffPrompt({
          dispatchId, taskProjectRoot: agent.cwd,
          triggerPeriods: dispatchWindows.map((entry) => entry.quota.period),
        });
      } catch {
        this.set(agent.id, { ...base, status: "unknown", reason: "no-project-root" });
        return;
      }
      claimed = await this.ports.store.claimGroup({
        id: dispatchId, key: selected.key, agentId: agent.id, taskProjectRoot: agent.cwd, claimedAt,
      }, alsoTriggered.map((entry) => entry.key));
      if (claimed) break;
      if (attempt === 1) break;
      const concurrent = await this.ports.quota(agent.id, true);
      const stable = this.stableEligible(finalStable.eligible, concurrent, config);
      if (stable.accountChanged || stable.eligible.length === 0) {
        this.set(agent.id, { ...base, status: "unknown", reason: "account-or-window-changed" });
        return;
      }
      dispatchWindows = [];
      for (const quota of stable.eligible) {
        if (!await this.priorClaim(agent.id, quota)) {
          dispatchWindows.push({ quota, key: this.keyFor(agent.id, quota) });
        }
      }
    }
    if (!claimed) {
      this.set(agent.id, { ...base, status: "claimed", reason: "already-sent" });
      return;
    }
    const dispatchKey = dispatchWindows[0].key;
    if (!await this.permitted(generation)) {
      await this.ports.store.cancelUnsent(dispatchKey);
      return;
    }
    this.set(agent.id, { ...base, status: "claimed", lastAttemptAt: claimedAt });
    try {
      await this.ports.send(agent.id, prompt, agent.isBusy ? "steer" : "idle",
        dispatchWindows.map((entry) => entry.quota), agent.cwd);
      await this.ports.store.update(dispatchKey, "accepted", { acceptedAt: this.ports.now() });
      this.set(agent.id, { ...base, status: "accepted", lastAttemptAt: claimedAt,
        reason: "verification-pending" });
    } catch (error) {
      if (error instanceof KnownUnsentError) {
        await this.ports.store.cancelUnsent(dispatchKey);
        if (error instanceof QuotaChangedBeforeSendError && quotaRetryBudget > 0 &&
          await this.permitted(generation)) {
          // A period recovered, reset or joined after the last read. Release the
          // old group and re-claim only currently eligible periods in this scan.
          await this.scanAgent(agent, config, generation, quotaRetryBudget - 1);
          return;
        }
        this.set(agent.id, { ...base,
          status: error instanceof DeferredSendError ? "deferred" : "skipped",
          reason: error instanceof DeferredSendError ? "turn-in-progress" : "settings-changed" });
      } else {
        await this.ports.store.update(dispatchKey, "uncertain", { reason: "dispatch-uncertain" });
        this.set(agent.id, { ...base, status: "uncertain", lastAttemptAt: claimedAt,
          reason: "dispatch-uncertain" });
      }
    }
  }

  private async reconcile(
    agent: Pick<AgentTarget, "id" | "cwd">,
    receipt: DispatchReceipt,
  ): Promise<void> {
    if (receipt.stage !== "accepted" && receipt.stage !== "uncertain") {
      return;
    }
    let result: ReturnType<typeof extractHandoffResult> = null;
    // The agent may finish before a slow --no-wait CLI acknowledgement returns.
    // claimedAt predates send, unlike acceptedAt which is only an ACK timestamp.
    try { result = extractHandoffResult(await this.ports.output(agent.id, receipt.claimedAt), receipt.id); }
    catch { /* accepted remains pending until observation is possible */ }
    if (result?.status === "failed") {
      await this.ports.store.update(receipt.key, "uncertain", { reason: "agent-reported-save-failure" });
      return;
    }
    if (result?.status === "saved") {
      let verified: string | null = null;
      try { verified = await (this.ports.verifyFile ?? verifyHandoffFile)(agent.cwd, result.path, receipt.claimedAt); }
      catch { /* accepted is not verified until a valid file readback */ }
      if (verified) {
        await this.ports.store.update(receipt.key, "verified", {
          documentPath: verified, verifiedAt: this.ports.now(),
        });
        return;
      }
    }
  }
}
