import assert from "node:assert/strict";
import { test } from "node:test";
import { monitorSettings } from "../shared/Settings";
import { DEFAULT_CONFIG, mayDispatch } from "../server/Policy";

test("fresh host installations have monitoring OFF and dry-run ON", () => {
  const settings = monitorSettings.schema.parse({});
  assert.equal(settings.enabled, false);
  assert.equal(settings.dryRun, true);
  assert.equal(settings.activeTurnMode, "steer");
  assert.deepEqual(settings.fiveHour, { enabled: true, remainingThresholdPercent: 10 });
  assert.deepEqual(settings.weekly, { enabled: true, remainingThresholdPercent: 10 });
  assert.equal(settings.pollIntervalSeconds, 60);
  assert.equal(settings.includeChildAgents, false);
});

test("settings reject unsafe thresholds, hot polling and too many agent IDs", () => {
  for (const value of [-1, 101, Number.POSITIVE_INFINITY, Number.NaN]) {
    assert.equal(monitorSettings.schema.safeParse({ fiveHour: { enabled: true, remainingThresholdPercent: value } }).success, false);
    assert.equal(monitorSettings.schema.safeParse({ weekly: { enabled: true, remainingThresholdPercent: value } }).success, false);
  }
  for (const seconds of [1, 29, 3601, 31.5]) {
    assert.equal(monitorSettings.schema.safeParse({ pollIntervalSeconds: seconds }).success, false);
  }
  assert.equal(monitorSettings.schema.safeParse({ targetAgentIds: Array.from({ length: 51 }, (_, i) => `agent_${i}`) }).success, false);
  assert.equal(monitorSettings.schema.safeParse({ activeTurnMode: "interrupt" }).success, false);
});

test("migration preserves user's five-hour threshold without opting into weekly monitoring", () => {
  const raw = monitorSettings.migrate?.({ enabled: false, dryRun: true, remainingThresholdPercent: 37.5 }, 1);
  const settings = monitorSettings.schema.parse(raw);
  assert.equal(settings.enabled, false);
  assert.equal(settings.dryRun, true);
  assert.deepEqual(settings.fiveHour, { enabled: true, remainingThresholdPercent: 37.5 });
  assert.deepEqual(settings.weekly, { enabled: false, remainingThresholdPercent: 10 });
  assert.equal(settings.activeTurnMode, "steer");
});

test("live v1 configurations never silently enable a new weekly trigger on upgrade", () => {
  const raw = monitorSettings.migrate?.({ enabled: true, dryRun: false, remainingThresholdPercent: 23.5 }, 1);
  const settings = monitorSettings.schema.parse(raw);
  assert.equal(settings.enabled, true);
  assert.equal(settings.dryRun, false);
  assert.deepEqual(settings.fiveHour, { enabled: true, remainingThresholdPercent: 23.5 });
  assert.deepEqual(settings.weekly, { enabled: false, remainingThresholdPercent: 10 });
});

test("v2 settings keep independent periods and migrate to active-turn steering", () => {
  const raw = monitorSettings.migrate?.({ ...DEFAULT_CONFIG, activeTurnMode: undefined,
    fiveHour: { enabled: true, remainingThresholdPercent: 23.5 },
    weekly: { enabled: false, remainingThresholdPercent: 2 },
  }, 2);
  const settings = monitorSettings.schema.parse(raw);
  assert.equal(settings.activeTurnMode, "steer");
  assert.equal(settings.fiveHour.remainingThresholdPercent, 23.5);
  assert.deepEqual(settings.weekly, { enabled: false, remainingThresholdPercent: 2 });
});

test("pre-send authorization expires on reload, setting revision, or disabled monitoring", () => {
  const live = { ...DEFAULT_CONFIG, enabled: true, dryRun: false };
  assert.equal(mayDispatch(live, 4, 4, false), true);
  assert.equal(mayDispatch(live, 4, 5, false), false);
  assert.equal(mayDispatch(live, 4, 4, true), false);
  assert.equal(mayDispatch({ ...live, enabled: false }, 4, 4, false), false);
  assert.equal(mayDispatch({ ...live, dryRun: true }, 4, 4, false), false);
});
