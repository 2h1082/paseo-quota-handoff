/** Account quota decisions, with separately configured five-hour and weekly windows. */
export const QUOTA_PERIODS = ["five_hour", "weekly"] as const;
export type QuotaPeriod = (typeof QUOTA_PERIODS)[number];

export type QuotaSample =
  | {
      status: "available";
      period: QuotaPeriod;
      sourceId: string;
      accountKey: string;
      windowId: string;
      resetAt: string;
      fetchedAt: number;
      remainingPercent: number;
      durationMinutes: 300 | 10080;
    }
  | { status: "unknown" | "error"; period: QuotaPeriod; reason: string; fetchedAt?: number };

export type QuotaWindows = Record<QuotaPeriod, QuotaSample>;

export interface QuotaRule { enabled: boolean; remainingThresholdPercent: number }

export interface MonitorConfig {
  enabled: boolean;
  dryRun: boolean;
  /** Request the handoff inside an active turn for providers with known steering support. */
  activeTurnMode: "steer" | "defer";
  fiveHour: QuotaRule;
  weekly: QuotaRule;
  pollIntervalSeconds: number;
  includeChildAgents: boolean;
  targetAgentIds: string[];
}

export const DEFAULT_CONFIG: MonitorConfig = {
  enabled: false,
  dryRun: true,
  activeTurnMode: "steer",
  fiveHour: { enabled: true, remainingThresholdPercent: 10 },
  weekly: { enabled: true, remainingThresholdPercent: 10 },
  pollIntervalSeconds: 60,
  includeChildAgents: false,
  targetAgentIds: [],
};

export type QuotaDecision =
  | { kind: "eligible"; quota: Extract<QuotaSample, { status: "available" }> }
  | { kind: "skip" | "unknown"; reason: string };

export const MAX_REPORT_AGE_MS = 7 * 60 * 1000;

export function ruleFor(config: MonitorConfig, period: QuotaPeriod): QuotaRule {
  return period === "five_hour" ? config.fiveHour : config.weekly;
}

export function evaluateQuota(reading: QuotaSample, config: MonitorConfig, now: number): QuotaDecision {
  if (!config.enabled) return { kind: "skip", reason: "monitor-off" };
  const rule = ruleFor(config, reading.period);
  if (!rule.enabled) return { kind: "skip", reason: "period-disabled" };
  if (reading.status !== "available") return { kind: "unknown", reason: reading.reason };
  const expected = reading.period === "five_hour" ? 300 : 10080;
  if (
    reading.durationMinutes !== expected ||
    !reading.sourceId || !reading.accountKey || !reading.windowId || !reading.resetAt ||
    !Number.isFinite(reading.remainingPercent) ||
    reading.remainingPercent < 0 || reading.remainingPercent > 100 ||
    !Number.isFinite(reading.fetchedAt) ||
    reading.fetchedAt > now + 30_000 || now - reading.fetchedAt > MAX_REPORT_AGE_MS ||
    !Number.isFinite(Date.parse(reading.resetAt)) || Date.parse(reading.resetAt) <= now
  ) return { kind: "unknown", reason: "invalid-or-stale-window" };
  if (reading.remainingPercent > rule.remainingThresholdPercent) {
    return { kind: "skip", reason: "above-threshold" };
  }
  return { kind: "eligible", quota: reading };
}

export function sameWindow(a: QuotaSample, b: QuotaSample): boolean {
  return a.status === "available" && b.status === "available" &&
    a.period === b.period && a.sourceId === b.sourceId && a.accountKey === b.accountKey &&
    a.windowId === b.windowId && a.resetAt === b.resetAt;
}

/** Final account/window and threshold gate immediately before the CLI send. */
export function sameEligibleWindows(
  claimed: Extract<QuotaSample, { status: "available" }>[], current: QuotaWindows,
  config: MonitorConfig, now: number,
): boolean {
  return claimed.length > 0 && claimed.every((before) => {
    const after = current[before.period];
    return sameWindow(before, after) && evaluateQuota(after, config, now).kind === "eligible";
  });
}

export function isValidConfig(config: MonitorConfig): boolean {
  return !!config && typeof config.enabled === "boolean" && typeof config.dryRun === "boolean" &&
    (config.activeTurnMode === "steer" || config.activeTurnMode === "defer") &&
    [config.fiveHour, config.weekly].every((rule) =>
      !!rule && typeof rule.enabled === "boolean" &&
      Number.isFinite(rule.remainingThresholdPercent) &&
      rule.remainingThresholdPercent >= 0 && rule.remainingThresholdPercent <= 100) &&
    Number.isInteger(config.pollIntervalSeconds) &&
    config.pollIntervalSeconds >= 30 && config.pollIntervalSeconds <= 3600 &&
    Array.isArray(config.targetAgentIds) && config.targetAgentIds.length <= 50 &&
    config.targetAgentIds.every((id) => typeof id === "string" && !!id && id.length <= 200);
}

/** A pending CLI inspection cannot outlive a plugin reload or any settings revision. */
export function mayDispatch(
  config: MonitorConfig | null, requestGeneration: number, currentGeneration: number, closed: boolean,
): boolean {
  return !closed && requestGeneration === currentGeneration && !!config &&
    isValidConfig(config) && config.enabled && !config.dryRun;
}
