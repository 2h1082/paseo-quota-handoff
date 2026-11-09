import assert from "node:assert/strict";
import { test } from "node:test";
import { DeferredSendError, KnownUnsentError, QuotaChangedBeforeSendError, knownSteeringProvider, listAgentTargets, recentAgentOutput, sendHandoff } from "../server/PaseoBridge";
import { DEFAULT_CONFIG, sameEligibleWindows, type QuotaSample, type QuotaWindows } from "../server/Policy";
import { createQuotaWindowReader } from "../server/QuotaReader";

const id = "11111111-2222-4333-8444-555555555555";
const cwd = process.platform === "win32" ? "D:\\WorkingProjects\\Example" : "/tmp/WorkingProjects/Example";
const inspect = { Id: id, Cwd: cwd, Status: "idle", Archived: false, ParentAgentId: null };

test("real Paseo 0.15.3 inspect PascalCase fields are accepted for safe idle delivery", async () => {
  const requests: string[][] = [];
  const cli = async (args: string[]) => {
    requests.push(args);
    if (args[0] === "agent" && args[1] === "inspect") return JSON.stringify(inspect);
    if (args[0] === "agent" && args[1] === "send") return JSON.stringify({ ok: true });
    throw new Error("unexpected invocation");
  };
  await sendHandoff(cli, id, "preserve this task", "idle");
  assert.deepEqual(requests.map((args) => args[1]), ["inspect", "inspect", "send"]);
  assert.equal(requests[2].includes("--no-wait"), true);
  assert.ok(requests[2].includes("--behavior"));
  assert.equal(requests[2][requests[2].indexOf("--behavior") + 1], "steer");
});

test("pre-send inspect failures are known unsent and never consume a quota claim", async () => {
  await assert.rejects(sendHandoff(async () => "not JSON", id, "preserve", "idle"), KnownUnsentError);
});

test("monitor OFF after async inspection prevents the actual send command", async () => {
  const requests: string[][] = [];
  const cli = async (args: string[]) => {
    requests.push(args);
    if (args[1] === "inspect") return JSON.stringify(inspect);
    throw new Error("send must not execute after OFF");
  };
  await assert.rejects(sendHandoff(cli, id, "preserve", "idle", async () => false), KnownUnsentError);
  assert.deepEqual(requests.map((args) => args[1]), ["inspect"]);
});

test("a portable agent account switch during slow inspect revokes the unsent handoff", async () => {
  const past: Extract<QuotaSample, { status: "available" }> = {
    status: "available", period: "five_hour", sourceId: "claude", accountKey: "original",
    windowId: "five_hour", resetAt: new Date(Date.now() + 3_600_000).toISOString(),
    fetchedAt: Date.now(), remainingPercent: 5, durationMinutes: 300,
  };
  const requests: string[][] = [];
  const cli = async (args: string[]): Promise<string> => {
    requests.push(args);
    if (args[1] === "inspect") return JSON.stringify({ ...inspect, Provider: "claude", Status: "running" });
    throw new Error("account changed, must not send");
  };
  const changed: QuotaWindows = {
    five_hour: { ...past, accountKey: "new-account" },
    weekly: { status: "unknown", period: "weekly", reason: "not-provided" },
  };
  await assert.rejects(sendHandoff(cli, id, "handoff", "steer", async (inspected) =>
    inspected.cwd === cwd && sameEligibleWindows([past], changed,
      { ...DEFAULT_CONFIG, enabled: true }, Date.now())), KnownUnsentError);
  assert.deepEqual(requests.map((args) => args[1]), ["inspect"]);
});

test("defer mode refuses to steer an agent that became busy during quota refresh", async () => {
  let inspections = 0;
  const requests: string[][] = [];
  const cli = async (args: string[]): Promise<string> => {
    requests.push(args);
    if (args[1] === "inspect") return JSON.stringify({ ...inspect,
      Provider: "codex", Status: ++inspections === 1 ? "idle" : "running" });
    throw new Error("defer mode must not steer the newly busy agent");
  };
  await assert.rejects(sendHandoff(cli, id, "handoff", "idle", async () => true), DeferredSendError);
  assert.deepEqual(requests.map((args) => args[1]), ["inspect", "inspect"]);
});

test("monitor OFF or reload during the final inspection cannot issue agent send", async () => {
  let stillEnabled = true;
  const requests: string[][] = [];
  let count = 0;
  const cli = async (args: string[]): Promise<string> => {
    requests.push(args);
    if (args[1] === "inspect") {
      if (++count === 2) stillEnabled = false; // monitoring toggles OFF while awaiting inspect
      return JSON.stringify(inspect);
    }
    throw new Error("send must be canceled after OFF/reload");
  };
  await assert.rejects(sendHandoff(cli, id, "handoff", "idle",
    async () => true, async () => stillEnabled), KnownUnsentError);
  assert.deepEqual(requests.map((args) => args[1]), ["inspect", "inspect"]);
});

test("account switching during the second inspect cancels an old-account handoff", async () => {
  const now = Date.now();
  let currentAccount = "account-A";
  let inspections = 0;
  let refreshed = 0;
  const requests: string[][] = [];
  const cli = async (args: string[]): Promise<string> => {
    requests.push(args);
    if (args[1] === "inspect") {
      if (++inspections === 2) currentAccount = "account-B";
      return JSON.stringify({ ...inspect, Provider: "codex", Status: "running" });
    }
    if (args[0] === "usage" && args[1] === "ls") {
      refreshed++;
      return JSON.stringify([{ id: currentAccount, sourceId: "codex",
        successfulAt: new Date(now).toISOString(),
        report: { status: "available", windows: [{ id: "five_hour", remainingPct: 5,
          resetsAt: new Date(now + 3_600_000).toISOString() }] } }]);
    }
    throw new Error("an account B send is forbidden by account A quota");
  };
  const read = createQuotaWindowReader({ runCli: cli });
  const original = (await read(id, false)).five_hour;
  assert.equal(original.status, "available");
  if (original.status !== "available") throw new Error("invalid fixture");
  const allow = async (): Promise<boolean | "quota-changed"> => {
    const current = await read(id, true);
    return sameEligibleWindows([original], current, { ...DEFAULT_CONFIG, enabled: true }, Date.now())
      ? true : "quota-changed";
  };
  await assert.rejects(sendHandoff(cli, id, "handoff", "steer", allow, allow),
    QuotaChangedBeforeSendError);
  assert.equal(inspections, 2);
  assert.equal(refreshed, 3, "one baseline read and two forced pre-send quota reads");
  const secondInspection = requests.findIndex((args, index) => args[1] === "inspect" &&
    requests.slice(0, index).filter((earlier) => earlier[1] === "inspect").length === 1);
  const finalUsage = requests.findLastIndex((args) => args[0] === "usage");
  assert.ok(finalUsage > secondInspection, "account identity is read again AFTER the last inspect");
  assert.equal(requests.some((args) => args[1] === "send"), false);
});

test("handoff result observation filters assistant messages instead of echoing outgoing prompts", async () => {
  let invoked: string[] = [];
  const content = await recentAgentOutput(async (args) => { invoked = args; return "assistant only"; }, id, Date.now());
  assert.equal(content, "assistant only");
  assert.equal(invoked[invoked.indexOf("--filter") + 1], "assistant_message");
  assert.equal(invoked.includes("text"), false);
});

test("busy or archived agents cannot be interrupted or messaged", async () => {
  const requests: string[][] = [];
  const cli = async (args: string[]) => {
    requests.push(args);
    return JSON.stringify({ ...inspect, Status: "running" });
  };
  await assert.rejects(sendHandoff(cli, id, "preserve", "idle"), DeferredSendError);
  assert.deepEqual(requests.map((args) => args[1]), ["inspect"]);
});

test("error and stopped agents reject steering even if the provider supports active turns", async () => {
  for (const status of ["error", "failed", "stopped", "closed", "archived", "initializing", "unknown"]) {
    const requests: string[][] = [];
    const cli = async (args: string[]) => {
      requests.push(args);
      if (args[1] === "inspect") return JSON.stringify({
        ...inspect, Provider: "codex", Status: status, running: false,
      });
      throw new Error("inactive agent must not receive handoff");
    };
    await assert.rejects(sendHandoff(cli, id, "handoff", "steer"), DeferredSendError);
    assert.deepEqual(requests.map((args) => args[1]), ["inspect"], status);
  }
});

test("known native providers accept active-turn steering, while unknown providers defer", async () => {
  for (const provider of ["codex", "claude", "opencode", "pi", "codex/gpt-6"]) {
    assert.equal(knownSteeringProvider(provider), true);
  }
  assert.equal(knownSteeringProvider("antigravity/gemini"), false);
  const requests: string[][] = [];
  const cli = async (args: string[]) => {
    requests.push(args);
    if (args[1] === "inspect") return JSON.stringify({ ...inspect, Provider: "codex", Status: "running" });
    return JSON.stringify({ ok: true });
  };
  await sendHandoff(cli, id, "finish safe checkpoint and hand off", "steer");
  assert.deepEqual(requests.map((args) => args[1]), ["inspect", "inspect", "send"]);
  assert.equal(requests[2][requests[2].indexOf("--behavior") + 1], "steer");
  requests.length = 0;
  await assert.rejects(sendHandoff(cli, id, "handoff", "idle"), DeferredSendError);
  assert.deepEqual(requests.map((args) => args[1]), ["inspect"]);
});

test("plugin cleanup during a deferred CLI inspect prevents handoff dispatch", async () => {
  let active = true;
  const requests: string[][] = [];
  const cli = async (args: string[]) => {
    requests.push(args);
    if (args[1] === "inspect") {
      active = false; // Simulate a plugin reload while the asynchronous inspector is in flight.
      return JSON.stringify({ ...inspect, Provider: "codex", Status: "running" });
    }
    throw new Error("send must not execute after plugin cleanup");
  };
  await assert.rejects(sendHandoff(cli, id, "handoff", "steer", async () => active), KnownUnsentError);
  assert.deepEqual(requests.map((args) => args[1]), ["inspect"]);
});

test("agent listing excludes child agents unless explicitly included", async () => {
  const cli = async (args: string[]) => {
    if (args[1] === "ls") return JSON.stringify([
      { id, cwd, status: "idle" },
      { id: "child-agent", cwd, status: "idle" },
    ]);
    return JSON.stringify({ ...inspect,
      Id: args[2], ParentAgentId: args[2] === "child-agent" ? id : null });
  };
  const roots = await listAgentTargets(cli);
  assert.deepEqual(roots.map((agent) => agent.id), [id]);
  const all = await listAgentTargets(cli, { includeChildAgents: true, targetAgentIds: [] });
  assert.deepEqual(all.map((agent) => agent.id), [id, "child-agent"]);
});

test("background root agents are included even when child agents are excluded", async () => {
  let usedBackground = false;
  const cli = async (args: string[]) => {
    if (args[1] === "ls") {
      usedBackground = args.includes("--background");
      return JSON.stringify([{ id, cwd, status: "idle", background: true }]);
    }
    return JSON.stringify(inspect);
  };
  assert.deepEqual((await listAgentTargets(cli)).map((agent) => agent.id), [id]);
  assert.equal(usedBackground, true);
});
