import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { resolve } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { monitorSettings } from "./shared/Settings";
import { monitorDiagnosticsRpc } from "./shared/Diagnostics";
import { QuotaCoordinator, type AgentDiagnostic } from "./server/Coordinator";
import { FileDispatchStore, defaultStateFile, dispatchKey } from "./server/StateStore";
import { KnownUnsentError, inspectTaskProjectRoot, listAgentTargets, recentAgentOutput, sendHandoff } from "./server/PaseoBridge";
import { readQuotaWindows, runPaseoCli } from "./server/QuotaReader";
import { QUOTA_PERIODS, evaluateQuota, isValidConfig, mayDispatch, sameEligibleWindows, sameWindow, type MonitorConfig } from "./server/Policy";

/** The stable local daemon identity is never shown to the user or outgoing agent. */
function hostKey(): string {
  return createHash("sha256")
    .update("paseo-quota-handoff/host/v1\0")
    .update(hostname())
    .update("\0")
    .update(resolve(defaultStateFile()))
    .digest("hex");
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(monitorSettings);
  const store = new FileDispatchStore();
  let timer: ReturnType<typeof setInterval> | null = null;
  let verificationTimer: ReturnType<typeof setInterval> | null = null;
  let settingsRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let settingsUnavailable = false;
  let closed = false;
  let currentRevision: string | null = null;
  let configGeneration = 0;
  const coordinator = new QuotaCoordinator({
    hostId: hostKey(),
    now: Date.now,
    settings: async (): Promise<MonitorConfig | null> => {
      const current = await settings.read();
      return current.status === "ready" ? current.values : null;
    },
    agents: async () => {
      const current = await settings.read();
      if (current.status !== "ready" || !current.values.enabled) return [];
      return listAgentTargets(runPaseoCli, {
        includeChildAgents: current.values.includeChildAgents,
        targetAgentIds: current.values.targetAgentIds,
      });
    },
    quota: (agentId, forceRefresh) => readQuotaWindows(agentId, forceRefresh),
    send: async (agentId, prompt, behavior, claimedWindows, taskProjectRoot) => {
      // A cleanup or settings revision must revoke any in-flight CLI inspection.
      const requestGeneration = configGeneration;
      if (closed) throw new KnownUnsentError("monitor stopped");
      let current;
      try { current = await settings.read(); }
      catch { throw new KnownUnsentError("monitor settings unavailable"); }
      if (!mayDispatch(current.status === "ready" ? current.values : null,
        requestGeneration, configGeneration, closed)) throw new KnownUnsentError("monitor disabled");
      const currentClaimStillEligible = async (): Promise<boolean | "quota-changed"> => {
        if (closed || configGeneration !== requestGeneration) return false;
        try {
          const latest = await settings.read();
          if (latest.status !== "ready" || !mayDispatch(latest.values,
            requestGeneration, configGeneration, closed)) return false;
          // Snapshot pre-existing claims BEFORE the final quota refresh.
          // A slow disk read after the refresh would reopen the avoidable
          // account-switch window before the actual CLI send.
          const persisted = await store.list();
          const existingKeys = new Set(persisted.flatMap((receipt) =>
            [receipt.key, ...(receipt.coveredKeys ?? [])]));
          // Close the avoidable gap introduced by claim persistence and the
          // asynchronous agent inspection. Never authorize yesterday's account.
          const currentQuota = await readQuotaWindows(agentId, true);
          if (closed || configGeneration !== requestGeneration) return false;
          if (!sameEligibleWindows(claimedWindows, currentQuota, latest.values, Date.now())) {
            return "quota-changed";
          }
          // A second period may join the threshold while the CLI was inspecting.
          // Re-run the claim/dispatch as one combined message unless that period
          // was already claimed by an earlier dispatch on this host.
          for (const period of QUOTA_PERIODS) {
            const decision = evaluateQuota(currentQuota[period], latest.values, Date.now());
            if (decision.kind !== "eligible" ||
              claimedWindows.some((prior) => sameWindow(prior, decision.quota))) continue;
            const q = decision.quota;
            const key = dispatchKey(hostKey(), agentId, q.sourceId, q.accountKey,
              q.windowId, q.resetAt, q.period);
            const legacy = q.period === "five_hour" ? dispatchKey(hostKey(), agentId,
              q.sourceId, q.accountKey, q.windowId, q.resetAt) : "";
            if (!existingKeys.has(key) && !(legacy && existingKeys.has(legacy))) {
              return "quota-changed";
            }
          }
          return !closed && configGeneration === requestGeneration;
        } catch { return false; }
      };
      await sendHandoff(runPaseoCli, agentId, prompt, behavior, async (inspected) => {
        const normalPath = (path: string) => process.platform === "win32"
          ? resolve(path).toLowerCase() : resolve(path);
        if (normalPath(inspected.cwd) !== normalPath(taskProjectRoot)) return false;
        return currentClaimStillEligible();
      }, currentClaimStillEligible);
    },
    output: (agentId, acceptedAt) => recentAgentOutput(runPaseoCli, agentId, acceptedAt),
    agentTaskProjectRoot: (agentId) => inspectTaskProjectRoot(runPaseoCli, agentId),
    store,
  });

  function stopTimer(): void {
    if (timer) clearInterval(timer);
    timer = null;
    if (settingsRetryTimer) clearTimeout(settingsRetryTimer);
    settingsRetryTimer = null;
  }

  async function applySettings(retry = 0): Promise<void> {
    const generation = ++configGeneration;
    coordinator.invalidate();
    stopTimer();
    if (closed) return;
    let current;
    try { current = await settings.read(); }
    catch {
      if (closed || generation !== configGeneration) return;
      // Fail closed on a temporary settings fault, then recover without
      // requiring the operator to manually toggle or reload the plugin.
      settingsUnavailable = true;
      const delay = Math.min(60_000, 2_000 * (2 ** Math.min(retry, 5)));
      settingsRetryTimer = setTimeout(() => {
        settingsRetryTimer = null;
        void applySettings(retry + 1);
      }, delay);
      settingsRetryTimer.unref?.();
      return;
    }
    settingsUnavailable = false;
    if (closed || generation !== configGeneration || current.status !== "ready" ||
      !current.values.enabled || !isValidConfig(current.values)) return;
    // Avoid concurrent settings subscriptions overriding a newer revision.
    if (currentRevision !== null && current.revision !== currentRevision) return;
    timer = setInterval(() => { void coordinator.scan(); }, current.values.pollIntervalSeconds * 1000);
    timer.unref?.();
    void coordinator.scan();
  }

  // OFF prevents quota scans and sends; a separate read-only timer may still
  // verify handoffs accepted before monitoring was disabled.
  const unsubscribe = settings.subscribe((current) => {
    currentRevision = current.revision;
    void applySettings();
  });
  void settings.read().then((current) => {
    if (closed || currentRevision !== null) return;
    currentRevision = current.revision;
    void applySettings();
  }).catch(() => {
    // The first read can also fail before any subscription revision exists.
    if (!closed && currentRevision === null) void applySettings();
  });

  const stopTurnHook = server.addHook("agent.turn.after", async () => {
    if (closed) return;
    // Scan on completed turns in addition to the periodic daemon timer.
    await coordinator.scan();
    void coordinator.reconcileOutstanding();
  });

  // Completing an already accepted handoff is allowed while quota monitoring is OFF.
  verificationTimer = setInterval(() => { void coordinator.reconcileOutstanding(); }, 60_000);
  verificationTimer.unref?.();
  void coordinator.reconcileOutstanding();

  server.handle(monitorDiagnosticsRpc, async () => {
    const current = coordinator.diagnostics();
    const map = new Map<string, AgentDiagnostic>(current.agents.map((agent) => [agent.agentId, agent]));
    try {
      const receipts = (await store.list()).sort((a, b) => a.claimedAt - b.claimedAt);
      const newestByAgent = new Map<string, typeof receipts[number]>();
      for (const receipt of receipts) {
        let diagnostic = map.get(receipt.agentId);
        if (!diagnostic) {
          diagnostic = { agentId: receipt.agentId,
            status: receipt.stage === "claimed" ? "uncertain" : receipt.stage };
          map.set(receipt.agentId, diagnostic);
        }
        newestByAgent.set(receipt.agentId, receipt);
        if (receipt.stage === "verified" && receipt.documentPath) {
          diagnostic.lastVerifiedDocument = receipt.documentPath;
        }
      }
      for (const [agentId, receipt] of newestByAgent) {
        const diagnostic = map.get(agentId)!;
        diagnostic.lastDispatchStage = receipt.stage;
        diagnostic.lastAttemptAt = receipt.claimedAt;
        if (["claimed", "accepted", "verified", "uncertain", "unknown"].includes(diagnostic.status)) {
          diagnostic.status = receipt.stage === "claimed" ? "uncertain" : receipt.stage;
          diagnostic.reason = receipt.stage === "accepted" ? "verification-pending" :
            receipt.stage === "claimed" ? "dispatch-uncertain" : receipt.reason;
        }
      }
    } catch { /* Stored diagnostics unavailable; monitoring still fails closed. */ }
    return { lastScanAt: current.lastScanAt, busy: current.busy,
      scanError: settingsUnavailable ? "settings-unavailable" : current.scanError,
      agents: [...map.values()] };
  });

  return () => {
    closed = true;
    coordinator.stop();
    stopTimer();
    if (verificationTimer) clearInterval(verificationTimer);
    unsubscribe();
    stopTurnHook();
  };
}
