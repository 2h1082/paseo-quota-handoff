import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { QuotaCoordinator } from "../server/Coordinator";
import { FileDispatchStore } from "../server/StateStore";
import { listAgentTargets, recentAgentOutput, sendHandoff } from "../server/PaseoBridge";
import { createQuotaWindowReader } from "../server/QuotaReader";
import { DEFAULT_CONFIG } from "../server/Policy";

test("automatic five-hour + weekly trigger steers an active agent once and verifies its real file", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-automatic-handoff-"));
  try {
    await writeFile(join(root, "AGENTS.md"), "# Test task project\n", "utf8");
    const agentId = "11111111-2222-4333-8444-555555555555";
    const inspect = { Id: agentId, Cwd: root, Provider: "codex", Status: "running", Archived: false };
    const now = Date.now();
    let simulatedNow = now;
    const fetchedAt = new Date(now - 60_000).toISOString();
    const windows = [
      { id: "five_hour", usedPct: 90, resetsAt: new Date(now + 3_600_000).toISOString() },
      { id: "weekly", usedPct: 98, resetsAt: new Date(now + 7 * 86_400_000).toISOString() },
    ];
    const quotaReport = [{ id: "opaque-current-account", sourceId: "codex", successfulAt: fetchedAt,
      report: { status: "available", windows } }];
    let sends = 0;
    let assistantOutput = "";
    let readbackSince: string | undefined;
    const cli = async (args: string[]): Promise<string> => {
      if (args[0] === "agent" && args[1] === "ls") return JSON.stringify([{ id: agentId, cwd: root, status: "running", provider: "codex" }]);
      if (args[0] === "agent" && args[1] === "inspect") return JSON.stringify(inspect);
      if (args[0] === "usage" && args[1] === "ls") return JSON.stringify(quotaReport);
      if (args[0] === "agent" && args[1] === "send") {
        sends++;
        assert.equal(args[args.indexOf("--behavior") + 1], "steer");
        const prompt = args[args.indexOf("--prompt") + 1];
        assert.match(prompt, /finish the current bounded operation/);
        assert.match(prompt, /five-hour and weekly quota/);
        const dispatchId = prompt.match(/dispatchId=([A-Za-z0-9_-]+)/)?.[1];
        assert.ok(dispatchId);
        const handoffs = join(root, "Docs", "Handoffs");
        await mkdir(handoffs, { recursive: true });
        const path = join(handoffs, "Task.md");
        await writeFile(path, [
          "# Handoff of current implementation",
          "## Decisions\nPreserve project-local instructions and previously completed milestones.",
          "## Pending\nContinue the verification from the recorded checkpoint.",
          "## Verification\nThis is a disposable injected test of the verification boundary.",
          "## References\nConsult the current plan and test artifacts in this project.",
          "## Suggested skills\nUse the applicable coding and review skills.",
        ].join("\n\n"), "utf8");
        assistantOutput = `HANDOFF_RESULT: ${JSON.stringify({ dispatchId, status: "saved", path })}`;
        // The file and assistant response exist before the daemon's CLI ACK.
        // Reproduce a slow CLI response without a real clock delay.
        simulatedNow = now + 10_000;
        return JSON.stringify({ ok: true });
      }
      if (args[0] === "agent" && args[1] === "logs") {
        assert.equal(args[args.indexOf("--filter") + 1], "assistant_message");
        readbackSince = args[args.indexOf("--since") + 1];
        return assistantOutput;
      }
      throw new Error("unexpected fake Paseo CLI operation");
    };
    const config = { ...DEFAULT_CONFIG, enabled: true, dryRun: false, activeTurnMode: "steer" as const };
    const store = new FileDispatchStore(join(root, "State.json"));
    const reader = createQuotaWindowReader({ runCli: cli });
    const coordinator = new QuotaCoordinator({
      hostId: "isolated-test-daemon", now: () => simulatedNow,
      settings: async () => config,
      agents: () => listAgentTargets(cli),
      quota: (id, refresh) => reader(id, refresh),
      send: (id, prompt, behavior) => sendHandoff(cli, id, prompt, behavior),
      output: (id, acceptedAt) => recentAgentOutput(cli, id, acceptedAt),
      store,
    });
    await coordinator.scan();
    assert.equal(sends, 1);
    let receipts = await store.list();
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].coveredKeys?.length, 1);
    assert.equal(receipts[0].stage, "accepted");
    assert.ok((receipts[0].acceptedAt ?? 0) - receipts[0].claimedAt >= 10_000,
      "the daemon acknowledgement may arrive long after the file was written");

    config.enabled = false;
    await coordinator.reconcileOutstanding();
    receipts = await store.list();
    assert.equal(receipts[0].stage, "verified");
    assert.ok(Date.parse(readbackSince ?? "") < (receipts[0].acceptedAt ?? 0) - 5_000,
      "assistant readback begins at dispatch time even when acknowledgement was late");
    assert.match(receipts[0].documentPath ?? "", /Docs[\\/]Handoffs[\\/]Task\.md$/);
    await coordinator.scan();
    assert.equal(sends, 1, "turn hook and periodic scans never repeat an accepted handoff");
  } finally { await rm(root, { recursive: true, force: true }); }
});
