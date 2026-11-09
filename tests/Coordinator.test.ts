import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { QuotaCoordinator, type AgentTarget, type CoordinatorPorts } from "../server/Coordinator";
import { DispatchStoreLockedError, dispatchKey, FileDispatchStore } from "../server/StateStore";
import { DEFAULT_CONFIG, sameEligibleWindows, type MonitorConfig, type QuotaSample, type QuotaWindows } from "../server/Policy";
import { QuotaChangedBeforeSendError } from "../server/PaseoBridge";

const now = Date.parse("2026-11-09T00:00:00.000Z");
const tempPaths: string[] = [];
afterEach(async () => { await Promise.all(tempPaths.splice(0).map((file) => rm(file, { recursive: true, force: true }))); });

function available(remainingPercent: number, change: Record<string, unknown> = {}): QuotaSample {
  return {
    status: "available", period: "five_hour", sourceId: "codex", accountKey: "private-opaque-account",
    windowId: "five_hour", resetAt: new Date(now + 2 * 3600_000).toISOString(),
    fetchedAt: now - 120_000, remainingPercent, durationMinutes: 300,
    ...change,
  } as QuotaSample;
}

function weekly(remainingPercent: number, change: Record<string, unknown> = {}): QuotaSample {
  return {
    status: "available", period: "weekly", sourceId: "codex", accountKey: "private-opaque-account",
    windowId: "weekly", resetAt: new Date(now + 3 * 24 * 3600_000).toISOString(),
    fetchedAt: now - 120_000, remainingPercent, durationMinutes: 10080,
    ...change,
  } as QuotaSample;
}

function windows(fiveHour: QuotaSample = available(10), week: QuotaSample = {
  status: "unknown", period: "weekly", reason: "weekly_missing",
}): QuotaWindows { return { five_hour: fiveHour, weekly: week }; }

const agent: AgentTarget = {
  id: "agent_1", cwd: "C:\\Work\\TaskProject", isActive: true,
  isChild: false, isBusy: false, supportsSteer: false,
};

async function harness(config: MonitorConfig = { ...DEFAULT_CONFIG, enabled: true }) {
  const folder = await mkdtemp(join(tmpdir(), "quota-coordinator-"));
  tempPaths.push(folder);
  let candidates: AgentTarget[] = [agent];
  let reading: QuotaWindows = windows();
  let refreshed: QuotaWindows | null = null;
  let emitted = "";
  let outputGate: Promise<void> | null = null;
  let legacyRoot: string | null = null;
  let sendError: Error | undefined;
  let beforeSend: (() => Promise<void>) | undefined;
  let onRefresh: (() => void) | undefined;
  let scans = 0;
  const sent: Array<{ agentId: string; prompt: string }> = [];
  const store = new FileDispatchStore(join(folder, "State.json"));
  const ports: CoordinatorPorts = {
    hostId: "host-1", now: () => now,
    settings: async () => config,
    agents: async () => { scans++; return candidates; },
    quota: async (_id, refresh) => {
      if (refresh) { onRefresh?.(); return refreshed ?? reading; }
      return reading;
    },
    send: async (agentId, prompt) => {
      if (beforeSend) await beforeSend();
      sent.push({ agentId, prompt });
      if (sendError) throw sendError;
    },
    output: async () => { if (outputGate) await outputGate; return emitted; },
    agentTaskProjectRoot: async () => legacyRoot,
    store, verifyFile: async (_cwd, path) => path.startsWith("C:\\Work\\TaskProject\\Docs\\Handoffs\\") ? path : null,
  };
  const coordinator = new QuotaCoordinator(ports);
  return { coordinator, store, sent, config,
    setReading(value: QuotaSample | QuotaWindows) {
      reading = "five_hour" in value ? value : { ...reading, [value.period]: value };
    },
    setRefreshed(value: QuotaSample | QuotaWindows) {
      refreshed = "five_hour" in value ? value : { ...reading, [value.period]: value };
    },
    setAgents(value: AgentTarget[]) { candidates = value; },
    setOnRefresh(value: () => void) { onRefresh = value; },
    setOutput(value: string) { emitted = value; },
    setOutputGate(waiter: Promise<void> | null) { outputGate = waiter; },
    setLegacyRoot(value: string) { legacyRoot = value; },
    setSendError(value: Error) { sendError = value; },
    setBeforeSend(value: () => Promise<void>) { beforeSend = value; },
    scans: () => scans,
    secondCoordinator: () => new QuotaCoordinator(ports),
  };
}

test("initial OFF performs no account reads or sends", async () => {
  const h = await harness({ ...DEFAULT_CONFIG });
  await h.coordinator.scan();
  assert.equal(h.scans(), 0);
  assert.equal(h.sent.length, 0);
});

test("cross-process lock acquisition failure is diagnosed and cannot send", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: false });
  h.store.claimGroup = async () => { throw new DispatchStoreLockedError(); };
  await h.coordinator.scan();
  assert.equal(h.sent.length, 0);
  assert.equal(h.coordinator.diagnostics().agents[0]?.reason, "store-locked");
});

test("separate plugin store instances cannot claim the same quota window concurrently", async () => {
  const folder = await mkdtemp(join(tmpdir(), "quota-dual-store-"));
  tempPaths.push(folder);
  const file = join(folder, "State.json");
  const first = new FileDispatchStore(file);
  const second = new FileDispatchStore(file);
  const key = dispatchKey("host", "agent", "provider", "opaque", "weekly", "reset", "weekly");
  const claimed = await Promise.all([
    first.claimGroup({ key, id: "dispatch-1", agentId: "agent", claimedAt: now }, []),
    second.claimGroup({ key, id: "dispatch-2", agentId: "agent", claimedAt: now }, []),
  ]);
  assert.deepEqual(claimed.sort(), [false, true]);
  assert.equal((await new FileDispatchStore(file).list()).length, 1);
});

test("a crashed process's orphan lock can be reclaimed without losing its persisted receipts", async () => {
  const folder = await mkdtemp(join(tmpdir(), "quota-orphan-lock-"));
  tempPaths.push(folder);
  const file = join(folder, "State.json");
  const original = new FileDispatchStore(file);
  const key = dispatchKey("host", "agent", "provider", "opaque", "weekly", "reset", "weekly");
  assert.equal(await original.claimGroup({ key, id: "original", agentId: "agent", claimedAt: now }, []), true);
  const lock = file + ".lock";
  await mkdir(lock);
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 999_999_999 }));
  const past = new Date(Date.now() - 120_000);
  await utimes(lock, past, past);
  const next = new FileDispatchStore(file);
  assert.equal(await next.claimGroup({ key, id: "duplicate", agentId: "agent", claimedAt: now }, []), false);
  assert.equal((await next.list()).length, 1);
});

test("11% skips, exactly 10% and 0% are candidates in dry-run", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: true });
  h.setReading(available(11));
  await h.coordinator.scan();
  assert.equal(h.coordinator.diagnostics().agents[0]?.status, "unknown");
  assert.equal(h.coordinator.diagnostics().agents[0]?.periods?.[0]?.reason, "above-threshold");
  h.setReading(available(10));
  await h.coordinator.scan();
  assert.equal(h.coordinator.diagnostics().agents[0]?.status, "candidate");
  h.setReading(available(0));
  await h.coordinator.scan();
  assert.equal(h.coordinator.diagnostics().agents[0]?.status, "candidate");
  assert.equal(h.sent.length, 0);
});

test("weekly-only 11% skips, 10% and 0% trigger at independent 10% settings", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: true });
  h.setReading(windows({ status: "unknown", period: "five_hour", reason: "five_hour_missing" }, weekly(11)));
  await h.coordinator.scan();
  assert.equal(h.coordinator.diagnostics().agents[0]?.periods?.[1]?.candidate, false);
  h.setReading(weekly(10));
  await h.coordinator.scan();
  assert.equal(h.coordinator.diagnostics().agents[0]?.status, "candidate");
  assert.deepEqual(h.coordinator.diagnostics().agents[0]?.periods?.map((period) => period.candidate), [false, true]);
  h.setReading(weekly(0));
  await h.coordinator.scan();
  assert.equal(h.coordinator.diagnostics().agents[0]?.status, "candidate");
  assert.equal(h.sent.length, 0);
});

test("weekly-only live trigger sends once and re-arms in a new seven-day window", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: false });
  h.setReading(windows({ status: "unknown", period: "five_hour", reason: "five_hour_missing" }, weekly(10)));
  await h.coordinator.scan();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].prompt, /reported weekly quota/);
  await h.secondCoordinator().scan();
  assert.equal(h.sent.length, 1);
  h.setReading(weekly(0, { resetAt: new Date(now + 11 * 24 * 3600_000).toISOString() }));
  await h.coordinator.scan();
  assert.equal(h.sent.length, 2);
});

test("independent 5h 23.5% and weekly 2% thresholds use inclusive comparison", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: true,
    fiveHour: { enabled: true, remainingThresholdPercent: 23.5 },
    weekly: { enabled: true, remainingThresholdPercent: 2 },
  });
  h.setReading(windows(available(23.5), weekly(3)));
  await h.coordinator.scan();
  assert.deepEqual(h.coordinator.diagnostics().agents[0]?.periods?.map((period) => period.candidate), [true, false]);
  assert.equal(h.coordinator.diagnostics().agents[0]?.periods?.[1]?.resetAt,
    new Date(now + 3 * 24 * 3600_000).toISOString());
  h.setReading(windows(available(24), weekly(2)));
  await h.coordinator.scan();
  assert.deepEqual(h.coordinator.diagnostics().agents[0]?.periods?.map((period) => period.candidate), [false, true]);
  h.config.fiveHour.enabled = false;
  h.setReading(windows(available(0), weekly(3)));
  await h.coordinator.scan();
  assert.deepEqual(h.coordinator.diagnostics().agents[0]?.periods?.map((period) => period.candidate), [false, false]);
  assert.equal(h.sent.length, 0);
});

test("simultaneous five-hour and weekly candidates reserve both windows in one message", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: false });
  h.setReading(windows(available(10), weekly(10)));
  await h.coordinator.scan();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].prompt, /five-hour and weekly quota/);
  const receipts = await h.store.list();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].coveredKeys?.length, 1);
  await h.secondCoordinator().scan();
  assert.equal(h.sent.length, 1);
});

test("a concurrent five-hour claim does not strand the still eligible weekly window", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: false });
  h.setReading(windows(available(10), weekly(10)));
  const claim = h.store.claimGroup.bind(h.store);
  let raced = false;
  h.store.claimGroup = async (receipt, coveredKeys) => {
    if (!raced) {
      raced = true;
      const five = available(10);
      if (five.status !== "available") throw new Error("bad test quota");
      const key = dispatchKey("host-1", agent.id, five.sourceId,
        five.accountKey, five.windowId, five.resetAt, "five_hour");
      assert.equal(await claim({ id: "concurrent-five", key,
        agentId: agent.id, claimedAt: now }, []), true);
    }
    return claim(receipt, coveredKeys);
  };
  await h.coordinator.scan();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].prompt, /reported weekly quota/);
  const receipts = await h.store.list();
  assert.equal(receipts.length, 2);
  assert.equal(receipts.find((receipt) => receipt.id === "concurrent-five")?.stage, "claimed");
  assert.equal(receipts.find((receipt) => receipt.id !== "concurrent-five")?.stage, "accepted");
  await h.secondCoordinator().scan();
  assert.equal(h.sent.length, 1, "both quota windows were accounted for");
});

test("final account, window and threshold must still match before delivery", () => {
  const config = { ...DEFAULT_CONFIG, enabled: true, dryRun: false };
  const before = [available(10), weekly(10)];
  if (before.some((entry) => entry.status !== "available")) throw new Error("bad test quota");
  const claimed = before as Extract<QuotaSample, { status: "available" }>[];
  assert.equal(sameEligibleWindows(claimed, windows(available(10), weekly(10)), config, now), true);
  assert.equal(sameEligibleWindows(claimed, windows(available(10, { accountKey: "other-account" }), weekly(10)), config, now), false);
  assert.equal(sameEligibleWindows(claimed, windows(available(10), weekly(10, { resetAt: new Date(now + 14 * 86400_000).toISOString() })), config, now), false);
  assert.equal(sameEligibleWindows(claimed, windows(available(10), weekly(11)), config, now), false);
  assert.equal(sameEligibleWindows([], windows(available(10), weekly(10)), config, now), false);
});

test("an eligible weekly window still sends immediately after five-hour quota recovers during inspect", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: false });
  h.setReading(windows(available(10), weekly(2)));
  let first = true;
  h.setBeforeSend(async () => {
    if (first) {
      first = false;
      h.setReading(windows(available(11), weekly(2)));
      throw new QuotaChangedBeforeSendError();
    }
  });
  await h.coordinator.scan();
  assert.equal(h.sent.length, 1, "surviving weekly trigger must not wait for the next poll");
  assert.match(h.sent[0].prompt, /reported weekly quota/);
  assert.equal((await h.store.list()).length, 1);
  assert.equal((await h.store.list())[0].coveredKeys?.length, 0);
});

test("a weekly threshold crossed during final send check joins a single new dispatch", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: false });
  h.setReading(windows(available(10), weekly(11)));
  let first = true;
  h.setBeforeSend(async () => {
    if (first) {
      first = false;
      h.setReading(windows(available(10), weekly(2)));
      throw new QuotaChangedBeforeSendError();
    }
  });
  await h.coordinator.scan();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].prompt, /five-hour and weekly quota/);
  assert.equal((await h.store.list())[0].coveredKeys?.length, 1);
  await h.secondCoordinator().scan();
  assert.equal(h.sent.length, 1, "both windows are claimed by the combined request");
});

test("generic provider window IDs with aligned reset still claim 5h and weekly separately", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: false });
  const sharedReset = new Date(now + 3 * 3600_000).toISOString();
  h.setReading(windows(
    available(10, { windowId: "provider_quota", resetAt: sharedReset }),
    weekly(10, { windowId: "provider_quota", resetAt: sharedReset }),
  ));
  await h.coordinator.scan();
  assert.equal(h.sent.length, 1);
  const receipts = await h.store.list();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].coveredKeys?.length, 1);
  assert.notEqual(receipts[0].key, receipts[0].coveredKeys?.[0]);
  await h.secondCoordinator().scan();
  assert.equal(h.sent.length, 1);
});

test("legacy five-hour one-shot receipt remains effective after adding period to key", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: false });
  const quota = available(10);
  if (quota.status !== "available") throw new Error("test fixture invalid");
  const legacy = dispatchKey("host-1", agent.id, quota.sourceId, quota.accountKey, quota.windowId, quota.resetAt);
  await h.store.claim({ id: "old-receipt", key: legacy, agentId: agent.id, claimedAt: now });
  await h.coordinator.scan();
  assert.equal(h.sent.length, 0);
});

test("legacy five-hour receipt with generic ID never suppresses a new weekly trigger", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: false });
  const reset = new Date(now + 3 * 3600_000).toISOString();
  const five = available(10, { windowId: "provider_quota", resetAt: reset });
  const week = weekly(10, { windowId: "provider_quota", resetAt: reset });
  if (five.status !== "available") throw new Error("test fixture invalid");
  const legacyKey = dispatchKey("host-1", agent.id, five.sourceId,
    five.accountKey, five.windowId, five.resetAt);
  await h.store.claim({ key: legacyKey, id: "old-five-hour", agentId: agent.id, claimedAt: now });
  h.setReading(windows(five, week));
  await h.coordinator.scan();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].prompt, /reported weekly quota/);
  assert.equal((await h.store.list()).length, 2);
});

test("a refreshed 5h recovery must not suppress a still eligible weekly quota", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: false });
  h.setReading(windows(available(5), weekly(2)));
  h.setRefreshed(windows(available(11), weekly(2)));
  await h.coordinator.scan();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].prompt, /reported weekly quota/);
  const receipts = await h.store.list();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].coveredKeys?.length, 0);
});

test("weekly threshold crossing during refresh joins original five-hour claim", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: false });
  h.setReading(windows(available(5), weekly(11)));
  h.setRefreshed(windows(available(5), weekly(2)));
  await h.coordinator.scan();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].prompt, /five-hour and weekly quota/);
  const receipts = await h.store.list();
  assert.equal(receipts[0].coveredKeys?.length, 1);
  h.setReading(windows(available(5), weekly(2)));
  await h.secondCoordinator().scan();
  assert.equal(h.sent.length, 1);
});

test("five-hour reset during final refresh still groups the qualifying weekly window", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: false });
  const first = windows(available(5), weekly(5));
  const next = windows(available(5, { resetAt: new Date(now + 9 * 3600_000).toISOString() }), weekly(5));
  h.setReading(first);
  h.setRefreshed(first);
  let refreshes = 0;
  h.setOnRefresh(() => {
    refreshes++;
    if (refreshes === 2) h.setRefreshed(next);
  });
  await h.coordinator.scan();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].prompt, /five-hour and weekly quota/);
  assert.equal((await h.store.list()).length, 1);
  assert.equal((await h.store.list())[0].coveredKeys?.length, 1);
  h.setReading(next);
  await h.secondCoordinator().scan();
  assert.equal(h.sent.length, 1);
});

test("weekly account switch between observation and refresh aborts both trigger windows", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: false });
  h.setReading(windows(available(10), weekly(10)));
  h.setRefreshed(windows(available(10), weekly(10, { accountKey: "different-account" })));
  await h.coordinator.scan();
  assert.equal(h.sent.length, 0);
  assert.equal(h.coordinator.diagnostics().agents[0]?.status, "unknown");
});

test("accepted handoff is verified after threshold rises and window resets", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: false });
  await h.coordinator.scan();
  const [receipt] = await h.store.list();
  const path = "C:\\Work\\TaskProject\\Docs\\Handoffs\\Task.md";
  h.setOutput("HANDOFF_RESULT: " + JSON.stringify({ dispatchId: receipt.id, status: "saved", path }));
  h.setReading(available(100, { resetAt: new Date(now + 12 * 3600_000).toISOString() }));
  await h.coordinator.scan();
  await h.coordinator.reconcileOutstanding();
  assert.equal((await h.store.list())[0].stage, "verified");
  assert.equal((await h.store.list())[0].documentPath, path);
});

test("an accepted handoff is verified after monitoring OFF and the agent disappears", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: false });
  await h.coordinator.scan();
  const [receipt] = await h.store.list();
  assert.equal(receipt.taskProjectRoot, agent.cwd);
  const path = "C:\\Work\\TaskProject\\Docs\\Handoffs\\Task.md";
  h.setOutput("HANDOFF_RESULT: " + JSON.stringify({ dispatchId: receipt.id, status: "saved", path }));
  h.setAgents([]);
  h.config.enabled = false;
  await h.coordinator.reconcileOutstanding();
  assert.equal((await h.store.list())[0].stage, "verified");
  assert.equal(h.sent.length, 1);
});

test("pre-upgrade accepted receipts recover the project root after monitoring is disabled", async () => {
  const h = await harness({ ...DEFAULT_CONFIG });
  const key = "legacy-account-window";
  await h.store.claim({ id: "legacy_dispatch_001", key, agentId: agent.id, claimedAt: now });
  await h.store.update(key, "accepted", { acceptedAt: now });
  h.setLegacyRoot(agent.cwd);
  const path = "C:\\Work\\TaskProject\\Docs\\Handoffs\\Legacy.md";
  h.setOutput("HANDOFF_RESULT: " + JSON.stringify({ dispatchId: "legacy_dispatch_001", status: "saved", path }));
  await h.coordinator.reconcileOutstanding();
  const receipt = (await h.store.list())[0];
  assert.equal(receipt.taskProjectRoot, agent.cwd);
  assert.equal(receipt.stage, "verified");
  assert.equal(receipt.documentPath, path);
  assert.equal(h.sent.length, 0);
});

test("legacy uncertain receipts recover their root without falsely becoming accepted", async () => {
  const h = await harness({ ...DEFAULT_CONFIG });
  const key = "legacy-uncertain-window";
  await h.store.claim({ id: "uncertain_dispatch_001", key, agentId: agent.id, claimedAt: now });
  await h.store.update(key, "uncertain", { reason: "dispatch-uncertain" });
  h.setLegacyRoot(agent.cwd);
  await h.coordinator.reconcileOutstanding();
  const [receipt] = await h.store.list();
  assert.equal(receipt.taskProjectRoot, agent.cwd);
  assert.equal(receipt.stage, "uncertain", "metadata recovery must preserve uncertain delivery");
  assert.equal(h.sent.length, 0);
});

test("a slow accepted-handoff readback never blocks fresh quota polling", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: false });
  await h.store.claim({
    id: "old_pending_001", key: "different-old-quota-window", agentId: agent.id,
    taskProjectRoot: agent.cwd, claimedAt: now,
  });
  await h.store.update("different-old-quota-window", "accepted", { acceptedAt: now });
  let release!: () => void;
  const outputGate = new Promise<void>((resolve) => { release = resolve; });
  h.setOutputGate(outputGate);
  const verifying = h.coordinator.reconcileOutstanding();
  await h.coordinator.scan();
  assert.equal(h.sent.length, 1, "quota detection and dispatch must not await readback");
  release();
  await verifying;
  h.setOutputGate(null);
});

test("multiple accepted handoffs for one agent display the newest receipt after out-of-order verification", async () => {
  const h = await harness({ ...DEFAULT_CONFIG });
  await h.store.claim({
    id: "legacy_old_001", key: "older-account-window", agentId: agent.id,
    taskProjectRoot: agent.cwd, claimedAt: now - 10_000,
  });
  await h.store.update("older-account-window", "accepted", { acceptedAt: now - 10_000 });
  await h.store.claim({
    id: "latest_new_001", key: "newer-account-window", agentId: agent.id,
    taskProjectRoot: agent.cwd, claimedAt: now,
  });
  await h.store.update("newer-account-window", "accepted", { acceptedAt: now });
  const path = "C:\\Work\\TaskProject\\Docs\\Handoffs\\Latest.md";
  h.setOutput("HANDOFF_RESULT: " + JSON.stringify({ dispatchId: "latest_new_001", status: "saved", path }));
  await h.coordinator.reconcileOutstanding();
  const receipts = await h.store.list();
  assert.equal(receipts.find((receipt) => receipt.id === "legacy_old_001")?.stage, "accepted");
  assert.equal(receipts.find((receipt) => receipt.id === "latest_new_001")?.stage, "verified");
  const diagnostic = h.coordinator.diagnostics().agents[0];
  assert.equal(diagnostic.status, "verified");
  assert.equal(diagnostic.documentPath, path);
  assert.equal(diagnostic.lastDispatchStage, "verified");
});

test("read-only verification store failures are sanitized without rejecting background task", async () => {
  const h = await harness({ ...DEFAULT_CONFIG });
  h.store.list = async () => { throw new DispatchStoreLockedError(); };
  await h.coordinator.reconcileOutstanding();
  assert.equal(h.coordinator.diagnostics().scanError, "store-locked");
  assert.equal(h.sent.length, 0);
});

test("stale, weekly-only, invalid and missing reset identity fail closed", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: false });
  for (const input of [
    available(0, { fetchedAt: now - 10 * 60_000 }),
    available(0, { durationMinutes: 10_080 }),
    available(Number.NaN), available(0, { resetAt: "" }),
    { status: "unknown", reason: "weekly-only" } as QuotaSample,
  ]) {
    h.setReading(input);
    await h.coordinator.scan();
    assert.equal(h.sent.length, 0);
    assert.equal(h.coordinator.diagnostics().agents[0]?.status, "unknown");
  }
});

test("accepted request stays one-shot across overlapping scans, restart, OFF/ON; new window re-arms", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: false });
  await Promise.all([h.coordinator.scan(), h.coordinator.scan()]);
  assert.equal(h.sent.length, 1);
  assert.equal(h.coordinator.diagnostics().agents[0]?.status, "accepted");
  await h.coordinator.scan();
  h.config.enabled = false;
  await h.coordinator.scan();
  h.config.enabled = true;
  await h.secondCoordinator().scan();
  assert.equal(h.sent.length, 1);
  h.setReading(available(0, { resetAt: new Date(now + 7 * 3600_000).toISOString() }));
  await h.coordinator.scan();
  assert.equal(h.sent.length, 2);
});

test("account switched before dispatch and settings turned OFF in flight cannot send", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: false });
  h.setRefreshed(available(2, { accountKey: "new-account" }));
  await h.coordinator.scan();
  assert.equal(h.sent.length, 0);
  h.setRefreshed(available(10));
  h.setOnRefresh(() => { h.config.enabled = false; });
  await h.coordinator.scan();
  assert.equal(h.sent.length, 0);
});

test("busy unsupported steer defers and child agents honor scope", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: false });
  h.setAgents([{ ...agent, isBusy: true }, { ...agent, id: "child", isChild: true }]);
  await h.coordinator.scan();
  assert.equal(h.sent.length, 0);
  assert.equal(h.coordinator.diagnostics().agents[0]?.status, "deferred");
  h.config.includeChildAgents = true;
  h.setAgents([{ ...agent, id: "child", isChild: true }]);
  await h.coordinator.scan();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].agentId, "child");
});

test("busy native-steering agents receive one in-turn handoff and defer mode waits", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: false, activeTurnMode: "steer" });
  h.setAgents([{ ...agent, isBusy: true, supportsSteer: true }]);
  await h.coordinator.scan();
  assert.equal(h.sent.length, 1);
  assert.equal((await h.store.list())[0].stage, "accepted");

  const deferred = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: false, activeTurnMode: "defer" });
  deferred.setAgents([{ ...agent, isBusy: true, supportsSteer: true }]);
  await deferred.coordinator.scan();
  assert.equal(deferred.sent.length, 0);
  assert.equal(deferred.coordinator.diagnostics().agents[0]?.status, "deferred");
});

test("several agents sharing one account each get a separate claim", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: false });
  h.setAgents([agent, { ...agent, id: "agent_2" }]);
  await h.coordinator.scan();
  assert.deepEqual(h.sent.map((record) => record.agentId), ["agent_1", "agent_2"]);
});

test("ambiguous send does not retry and is persisted as uncertain", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: false });
  h.setSendError(new Error("no response after server accepted"));
  await h.coordinator.scan();
  assert.equal(h.sent.length, 1);
  assert.equal(h.coordinator.diagnostics().agents[0]?.status, "uncertain");
  await h.secondCoordinator().scan();
  assert.equal(h.sent.length, 1);
  assert.equal((await h.store.list())[0]?.stage, "uncertain");
});

test("an uncertain transport can be verified from matching late evidence without re-sending", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: false });
  h.setSendError(new Error("CLI timed out after daemon accepted"));
  await h.coordinator.scan();
  const [receipt] = await h.store.list();
  assert.equal(receipt.stage, "uncertain");
  const path = "C:\\Work\\TaskProject\\Docs\\Handoffs\\Recovered.md";
  h.setOutput("HANDOFF_RESULT: " + JSON.stringify({ dispatchId: receipt.id, status: "saved", path }));
  h.config.enabled = false;
  await h.coordinator.reconcileOutstanding();
  assert.equal((await h.store.list())[0].stage, "verified");
  assert.equal((await h.store.list())[0].documentPath, path);
  assert.equal(h.sent.length, 1);
});

test("accepted and verified are distinct; only matching file evidence advances claim", async () => {
  const h = await harness({ ...DEFAULT_CONFIG, enabled: true, dryRun: false });
  await h.coordinator.scan();
  const [receipt] = await h.store.list();
  assert.equal(receipt.stage, "accepted");
  h.setOutput('HANDOFF_RESULT: {"dispatchId":"' + receipt.id + '","status":"saved","path":"C:\\\\Wrong\\\\Handoff.md"}');
  await h.coordinator.scan();
  await h.coordinator.reconcileOutstanding();
  assert.equal(h.coordinator.diagnostics().agents[0]?.status, "accepted");
  const outputPath = "C:\\Work\\TaskProject\\Docs\\Handoffs\\Task.md";
  h.setOutput("HANDOFF_RESULT: " + JSON.stringify({ dispatchId: receipt.id, status: "saved", path: outputPath }));
  await h.coordinator.scan();
  await h.coordinator.reconcileOutstanding();
  assert.equal(h.coordinator.diagnostics().agents[0]?.status, "verified");
  assert.equal((await h.store.list())[0]?.documentPath, outputPath);
});
