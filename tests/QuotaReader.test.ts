import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createQuotaReader, createQuotaWindowReader, localDaemonEnv, runPaseoCli } from "../server/QuotaReader";

const NOW = Date.parse("2026-11-09T00:00:00.000Z");
const RESET = "2026-11-09T03:00:00.000Z";

type FakeWindow = Record<string, unknown>;

function report(
  windows: FakeWindow[] = [
    { id: "five_hour", label: "Session", usedPct: 90, remainingPct: 10, resetsAt: RESET },
  ],
) {
  return {
    id: "opaque-report-key-1",
    sourceId: "codex-usage-source",
    sourceLabel: "Codex",
    account: { label: "private@example.test" },
    fetchedAt: new Date(NOW - 60_000).toISOString(),
    successfulAt: new Date(NOW - 60_000).toISOString(),
    report: { status: "available", windows },
  };
}

function readerFor(data: unknown, seenArgs?: string[][]) {
  return createQuotaReader({
    runCli: async (args) => {
      seenArgs?.push([...args]);
      return JSON.stringify(data);
    },
  });
}

describe("agent-scoped five-hour quota", () => {
  it("returns only safe fields, source identity and exact five-hour window", async () => {
    const seen: string[][] = [];
    const result = await readerFor([report()], seen)("agent-123", false, NOW);
    assert.equal(result.status, "available");
    if (result.status !== "available") return;
    assert.equal(result.sourceId, "codex-usage-source");
    assert.equal(result.windowId, "five_hour");
    assert.equal(result.resetAt, RESET);
    assert.equal(result.fetchedAt, NOW - 60_000);
    assert.equal(result.remainingPercent, 10);
    assert.match(result.accountKey, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(result), /private@example\.test|opaque-report-key-1/);
    assert.deepEqual(seen, [["usage", "ls", "--agent", "agent-123", "--json"]]);
  });

  it("forces fresh quota only when requested and preserves account key across reads", async () => {
    const seen: string[][] = [];
    const read = readerFor([report()], seen);
    const previous = await read("agent-123", false, NOW);
    const refreshed = await read("agent-123", true, NOW);
    assert.equal(previous.status, "available");
    assert.equal(refreshed.status, "available");
    if (previous.status !== "available" || refreshed.status !== "available") return;
    assert.equal(previous.accountKey, refreshed.accountKey);
    assert.deepEqual(seen[1], [
      "usage", "ls", "--agent", "agent-123", "--json", "--refresh",
    ]);
  });

  it("supports scoped duration-verified IDs and used percentage fallback", async () => {
    const result = await readerFor([report([
      { id: "model:five_hour", label: "Model · 5-hour", usedPct: 89, resetsAt: RESET },
    ])])("agent-123", false, NOW);
    assert.equal(result.status, "available");
    if (result.status === "available") assert.equal(result.remainingPercent, 11);
  });

  it("keeps a consumed five-hour window available with exactly zero remaining", async () => {
    const result = await readerFor([report([
      { id: "five_hour", usedPct: 100, remainingPct: 0, resetsAt: RESET },
    ])])("agent-123", false, NOW);
    assert.equal(result.status, "available");
    if (result.status === "available") assert.equal(result.remainingPercent, 0);
  });

  it("changes the opaque account key after a reported account switch", async () => {
    const first = await readerFor([report()])("agent-123", false, NOW);
    const next = await readerFor([{ ...report(), id: "opaque-report-key-2" }])("agent-123", false, NOW);
    assert.equal(first.status, "available");
    assert.equal(next.status, "available");
    if (first.status === "available" && next.status === "available") {
      assert.notEqual(first.accountKey, next.accountKey);
    }
  });

  it("rejects a five-hour label without a duration-proven ID", async () => {
    const result = await readerFor([report([
      { id: "unknown_primary", label: "Primary", shortLabel: "5h", usedPct: 97, resetsAt: RESET },
    ])])("agent-123", false, NOW);
    assert.deepEqual(result, { status: "unknown", reason: "five_hour_missing" });
  });

  it("ignores weekly quotas when no five-hour window exists", async () => {
    const result = await readerFor([report([
      { id: "weekly", label: "Weekly", remainingPct: 0, resetsAt: RESET },
    ])])("agent-123", false, NOW);
    assert.equal(result.status, "unknown");
  });

  it("accepts a numeric 300-minute duration even when the window ID is generic", async () => {
    const result = await readerFor([report([
      { id: "provider_limit", durationMinutes: 300, remainingPct: 5, resetsAt: RESET },
    ])])("agent-123", false, NOW);
    assert.equal(result.status, "available");
    if (result.status === "available") assert.equal(result.remainingPercent, 5);
  });

  it("fails closed when more than one five-hour quota is applicable", async () => {
    const result = await readerFor([report([
      { id: "five_hour", usedPct: 90, resetsAt: RESET },
      { id: "sonnet:five_hour", usedPct: 90, resetsAt: RESET },
    ])])("agent-123", false, NOW);
    assert.deepEqual(result, { status: "unknown", reason: "ambiguous_five_hour" });
  });

  it("rejects conflicting, missing and invalid percentages", async () => {
    for (const window of [
      { id: "five_hour", usedPct: 90, remainingPct: 30, resetsAt: RESET },
      { id: "five_hour", usedPct: null, remainingPct: null, resetsAt: RESET },
      { id: "five_hour", usedPct: 101, resetsAt: RESET },
      { id: "five_hour", remainingPct: -2, resetsAt: RESET },
    ]) {
      const result = await readerFor([report([window])])("agent-123", false, NOW);
      assert.equal(result.status, "unknown");
    }
  });

  it("checks successful fetch time and expiry, ignoring latest-attempt freshness", async () => {
    const stale = { ...report(), successfulAt: new Date(NOW - 360_000).toISOString() };
    const expired = report([{ id: "five_hour", usedPct: 95, resetsAt: new Date(NOW - 1).toISOString() }]);
    assert.deepEqual(await readerFor([stale])("agent-123", false, NOW), {
      status: "unknown", reason: "stale_report",
    });
    assert.deepEqual(await readerFor([expired])("agent-123", false, NOW), {
      status: "unknown", reason: "invalid_reset",
    });
  });

  it("ignores retained quota when the current report is unavailable", async () => {
    const previous = report();
    const unavailable = {
      ...previous,
      report: { status: "unavailable", problem: { kind: "no_quota", detail: "not connected" } },
      lastSuccessful: { fetchedAt: previous.fetchedAt, report: previous.report },
    };
    assert.deepEqual(await readerFor([unavailable])("agent-123", false, NOW), {
      status: "unknown", reason: "five_hour_missing",
    });
  });

  it("rejects malformed JSON, unsupported envelopes and empty input without leaking text", async () => {
    const invalid = createQuotaReader({ runCli: async () => "{ PRIVATE DATA" });
    assert.deepEqual(await invalid("agent-123", false, NOW), {
      status: "unknown", reason: "invalid_cli_json",
    });
    const envelope = await readerFor({ reports: [report()] })("agent-123", false, NOW);
    assert.equal(envelope.status, "unknown");
    assert.equal((await readerFor([])("agent-123", false, NOW)).status, "unknown");
  });

  it("rejects unsafe agent IDs before constructing CLI args", async () => {
    let calls = 0;
    const read = createQuotaReader({ runCli: async () => { calls++; return "[]"; } });
    const result = await read("--json", false, NOW);
    assert.deepEqual(result, { status: "unknown", reason: "invalid_agent_id" });
    assert.equal(calls, 0);
  });

  it("maps CLI failures and source errors into sanitized status", async () => {
    const failed = createQuotaReader({ runCli: async () => { throw new Error("secret-account"); } });
    assert.deepEqual(await failed("agent-123", false, NOW), {
      status: "error", reason: "cli_failed",
    });
    const errored = { ...report(), report: { status: "error", error: "private-token" } };
    assert.deepEqual(await readerFor([errored])("agent-123", false, NOW), {
      status: "error", reason: "source_error",
    });
  });
});

describe("shell-free Paseo CLI invocation", () => {
  it("executes a native binary using individual argv entries", async () => {
    const version = await runPaseoCli(["--version"], { cliPath: process.execPath });
    assert.match(version.trim(), /^v\d+\.\d+\.\d+/);
  });
});

describe("local daemon ownership", () => {
  it("strips inherited remote PASEO_HOST without altering source environment", () => {
    const inherited = { PASEO_HOST: "tcp://remote.example:5678", PASEO_HOME: "/home/local/.paseo", KEEP: "value" };
    const derived = localDaemonEnv(inherited);
    assert.equal(derived.PASEO_HOST, undefined);
    assert.equal(derived.PASEO_HOME, inherited.PASEO_HOME);
    assert.equal(derived.KEEP, "value");
    assert.equal(inherited.PASEO_HOST, "tcp://remote.example:5678");
  });
});

describe("independent five-hour and weekly quota windows", () => {
  const validWeekly = { id: "weekly", remainingPct: 10, resetsAt: "2026-11-14T03:00:00.000Z" };

  it("reads two windows in one agent-scoped CLI call without exposing account information", async () => {
    const calls: string[][] = [];
    const read = createQuotaWindowReader({ runCli: async (args) => {
      calls.push(args);
      return JSON.stringify([report([
        { id: "five_hour", remainingPct: 11, resetsAt: RESET }, validWeekly,
      ])]);
    } });
    const result = await read("agent-123", false, NOW);
    assert.equal(result.five_hour.status, "available");
    assert.equal(result.weekly.status, "available");
    if (result.five_hour.status !== "available" || result.weekly.status !== "available") return;
    assert.equal(result.five_hour.durationMinutes, 300);
    assert.equal(result.weekly.durationMinutes, 10080);
    assert.equal(result.weekly.remainingPercent, 10);
    assert.equal(result.weekly.accountKey, result.five_hour.accountKey);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /private@example\.test|opaque-report-key-1/);
  });

  it("fails closed when one agent-scoped response mixes two different accounts", async () => {
    const first = report([{ id: "five_hour", remainingPct: 2, resetsAt: RESET }]);
    const other = { ...report([validWeekly]), id: "another-current-account" };
    const read = createQuotaWindowReader({ runCli: async () => JSON.stringify([first, other]) });
    const result = await read("agent-123", false, NOW);
    assert.deepEqual(result.five_hour, { status: "unknown", period: "five_hour", reason: "conflicting_account_identity" });
    assert.deepEqual(result.weekly, { status: "unknown", period: "weekly", reason: "conflicting_account_identity" });
  });

  it("rejects a second account even if its weekly percentage is invalid", async () => {
    const first = report([{ id: "five_hour", remainingPct: 2, resetsAt: RESET }]);
    const second = { ...report([{ id: "weekly", remainingPct: "?", resetsAt: validWeekly.resetsAt }]),
      id: "different-account" };
    const read = createQuotaWindowReader({ runCli: async () => JSON.stringify([first, second]) });
    const result = await read("agent-123", false, NOW);
    assert.equal(result.five_hour.status, "unknown");
    assert.equal(result.weekly.status, "unknown");
    assert.equal(result.five_hour.reason, "conflicting_account_identity");
  });

  it("rejects a second account with a named weekly window but contradictory 5h duration", async () => {
    const first = report([{ id: "five_hour", remainingPct: 2, resetsAt: RESET }]);
    const second = { ...report([{ id: "weekly", durationMinutes: 300,
      remainingPct: 2, resetsAt: validWeekly.resetsAt }]), id: "different-account" };
    const read = createQuotaWindowReader({ runCli: async () => JSON.stringify([first, second]) });
    const result = await read("agent-123", false, NOW);
    assert.deepEqual(result.five_hour,
      { status: "unknown", period: "five_hour", reason: "conflicting_account_identity" });
    assert.deepEqual(result.weekly,
      { status: "unknown", period: "weekly", reason: "conflicting_account_identity" });
  });

  it("honors weekly-only quota when no five-hour window was reported", async () => {
    const result = await createQuotaWindowReader({ runCli: async () => JSON.stringify([report([validWeekly])]) })("agent-123", false, NOW);
    assert.equal(result.five_hour.status, "unknown");
    assert.equal(result.weekly.status, "available");
  });

  it("requires an explicit weekly identity or verified 604800-second duration", async () => {
    const read = async (data: Record<string, unknown>) => createQuotaWindowReader({
      runCli: async () => JSON.stringify([report([data])]),
    })("agent-123", false, NOW);
    const scoped = await read({ id: "claude:weekly", usedPct: 98, resetsAt: validWeekly.resetsAt });
    assert.equal(scoped.weekly.status, "available");
    const seconds = await read({ id: "provider_limit", durationSeconds: 604800, remainingPct: 0, resetsAt: validWeekly.resetsAt });
    assert.equal(seconds.weekly.status, "available");
    const unsupported = await read({ id: "inferred", label: "7 days", remainingPct: 0, resetsAt: validWeekly.resetsAt });
    assert.equal(unsupported.weekly.status, "unknown");
    const conflicting = await read({ id: "weekly", durationMinutes: 300, remainingPct: 0, resetsAt: validWeekly.resetsAt });
    assert.equal(conflicting.weekly.status, "unknown");
    assert.equal(conflicting.five_hour.status, "unknown", "a named weekly window must never trigger five-hour monitoring");
    const reverse = await read({ id: "five_hour", durationSeconds: 604800, remainingPct: 0, resetsAt: validWeekly.resetsAt });
    assert.equal(reverse.five_hour.status, "unknown");
    assert.equal(reverse.weekly.status, "unknown", "a named five-hour window must never trigger weekly monitoring");
    const scopedConflict = await read({ id: "provider:seven_day", durationMinutes: 300, remainingPct: 0, resetsAt: validWeekly.resetsAt });
    assert.equal(scopedConflict.five_hour.status, "unknown");
    assert.equal(scopedConflict.weekly.status, "unknown");
  });

  it("ambiguous weekly windows are UNKNOWN without discarding a valid five-hour window", async () => {
    const read = createQuotaWindowReader({ runCli: async () => JSON.stringify([report([
      { id: "five_hour", remainingPct: 10, resetsAt: RESET }, validWeekly,
      { id: "claude:weekly", remainingPct: 0, resetsAt: validWeekly.resetsAt },
    ])]) });
    const result = await read("agent-123", false, NOW);
    assert.equal(result.five_hour.status, "available");
    assert.deepEqual(result.weekly, { status: "unknown", period: "weekly", reason: "ambiguous_weekly" });
  });
});
