import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import process from "node:process";
import type { QuotaPeriod, QuotaSample, QuotaWindows } from "./Policy";
export type { QuotaSample, QuotaWindows } from "./Policy";

/**
 * A provider quota for the *current account* associated with an agent.
 * Account labels, raw Paseo report IDs, provider error text and CLI output
 * never leave this module. Consumers must not log accountKey.
 */
export interface PaseoCliOptions {
  /** Native executable or desktop-managed Paseo resources/bin/paseo.cmd. */
  cliPath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface QuotaReaderOptions {
  /** Injectable command boundary for fixture testing. */
  runCli?: (args: string[]) => Promise<string>;
  /** Age of a successful report before it is treated as unknown. */
  maxAgeMs?: number;
}

const FIVE_HOUR_SECONDS = 18_000;
const WEEKLY_SECONDS = 604_800;
const DEFAULT_MAX_AGE_MS = 5 * 60_000;
const FUTURE_SKEW_MS = 30_000;
const MAX_CLI_OUTPUT_BYTES = 2 * 1024 * 1024;
const VALID_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

class CliFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PaseoCliFailure";
  }
}

interface CliInvocation {
  executable: string;
  prefixArgs: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * The server is installed on the local Paseo daemon. Never inherit an external
 * PASEO_HOST target from its environment: an agent listing or send against a
 * remote daemon would violate per-host quota ownership and one-shot claims.
 */
export function localDaemonEnv(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...inherited };
  delete env.PASEO_HOST;
  env.PASEO_HOME ||= join(homedir(), ".paseo");
  return env;
}

/**
 * Windows Paseo Desktop ships a .cmd shim, which Node cannot reliably spawn
 * with shell:false. Reproduce its invocation with the underlying native exe,
 * retaining the daemon/CLI environment and argv boundaries.
 */
function desktopInvocation(shim: string): CliInvocation {
  const resources = resolve(dirname(shim), "..");
  const executable = resolve(resources, "..", "Paseo.exe");
  const runner = join(resources, "app.asar.unpacked", "dist", "daemon", "node-entrypoint-runner.js");
  const cliEntry = join(resources, "app.asar", "node_modules", "@getpaseo", "cli", "dist", "index.js");
  if (!existsSync(executable) || !existsSync(runner) || !existsSync(join(resources, "app.asar"))) {
    throw new CliFailure("desktop_cli_missing");
  }
  return {
    executable,
    prefixArgs: ["--disable-warning=DEP0040", runner, "node-script", cliEntry],
    env: {
      ...localDaemonEnv(process.env),
      ELECTRON_RUN_AS_NODE: "1",
      PASEO_NODE_ENV: "production",
      PASEO_DESKTOP_MANAGED: "1",
      PASEO_CLI: shim,
    },
  };
}

function resolveInvocation(cliPath?: string): CliInvocation {
  let chosen = cliPath?.trim() || process.env.PASEO_CLI?.trim();
  if (!chosen && process.platform === "win32" && process.env.LOCALAPPDATA) {
    const installed = join(process.env.LOCALAPPDATA, "Programs", "Paseo", "resources", "bin", "paseo.cmd");
    if (existsSync(installed)) chosen = installed;
  }
  chosen ||= "paseo";

  if (process.platform === "win32" && /\.cmd$|\.bat$/i.test(chosen)) {
    if (
      basename(chosen).toLowerCase() === "paseo.cmd" &&
      /[\\/]resources[\\/]bin[\\/]paseo\.cmd$/i.test(chosen)
    ) {
      return desktopInvocation(chosen);
    }
    // Never interpolate arbitrary command-line arguments into cmd.exe.
    throw new CliFailure("unsupported_cli_shim");
  }
  return { executable: chosen, prefixArgs: [], env: localDaemonEnv(process.env) };
}

/**
 * Run the local daemon's Paseo CLI with literal argv (no shell).
 * Errors are intentionally redacted: stdout/stderr could contain account data.
 *
 * Pass a CLI path through options when the daemon's installed version is not
 * on PATH; otherwise PASEO_CLI or the Windows Desktop bundle is discovered.
 */
export async function runPaseoCli(args: string[], options: PaseoCliOptions = {}): Promise<string> {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new CliFailure("invalid_cli_arguments");
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new CliFailure("invalid_cli_timeout");
  }
  const invocation = resolveInvocation(options.cliPath);

  return new Promise<string>((resolveOutput, rejectOutput) => {
    let settled = false;
    let stdout = "";
    let byteCount = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn>;
    const finish = (error?: CliFailure) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) rejectOutput(error);
      else resolveOutput(stdout);
    };

    try {
      child = spawn(invocation.executable, [...invocation.prefixArgs, ...args], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        env: invocation.env,
        signal: options.signal,
      });
    } catch {
      finish(new CliFailure("cli_spawn_failed"));
      return;
    }
    timer = setTimeout(() => {
      child.kill();
      finish(new CliFailure("cli_timed_out"));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      byteCount += Buffer.byteLength(chunk);
      if (byteCount > MAX_CLI_OUTPUT_BYTES) {
        child.kill();
        finish(new CliFailure("cli_output_too_large"));
        return;
      }
      stdout += chunk.toString();
    });
    child.on("error", () => finish(new CliFailure("cli_spawn_failed")));
    child.on("close", (code) => finish(code === 0 ? undefined : new CliFailure("cli_nonzero_exit")));
  });
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Paseo dates are ISO strings, not a duration inferred from a reset countdown. */
function parseIsoTimestamp(value: unknown): number | undefined {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
  ) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** A recognized provider period label must never be overridden by a conflicting duration. */
function namedPeriod(id: string): QuotaPeriod | null {
  const suffix = id.split(":").pop();
  if (suffix === "five_hour") return "five_hour";
  if (suffix === "weekly" || suffix === "seven_day") return "weekly";
  return null;
}

function isFiveHourWindow(window: RecordValue): boolean {
  const id = window.id;
  if (typeof id !== "string" || id.length === 0) return false;
  if (namedPeriod(id) === "weekly") return false;
  const durationSeconds = window.durationSeconds;
  const durationMinutes = window.durationMinutes;
  if (durationSeconds !== undefined && durationSeconds !== FIVE_HOUR_SECONDS) return false;
  if (durationMinutes !== undefined && durationMinutes !== FIVE_HOUR_SECONDS / 60) return false;

  // v0.15.3 windowFromReportedDuration(18000) produces "five_hour",
  // or "<scope>:five_hour"; Claude's named API field has the same ID.
  return id === "five_hour" || id.endsWith(":five_hour") ||
    durationSeconds === FIVE_HOUR_SECONDS || durationMinutes === FIVE_HOUR_SECONDS / 60;
}

function isWeeklyWindow(window: RecordValue): boolean {
  const id = window.id;
  if (typeof id !== "string" || id.length === 0) return false;
  if (namedPeriod(id) === "five_hour") return false;
  const durationSeconds = window.durationSeconds;
  const durationMinutes = window.durationMinutes;
  if (durationSeconds !== undefined && durationSeconds !== WEEKLY_SECONDS) return false;
  if (durationMinutes !== undefined && durationMinutes !== WEEKLY_SECONDS / 60) return false;

  // Paseo v0.15.3 uses weekly or scope:weekly; explicit seven-day provider
  // reports may use seven_day. Never infer duration from reset timestamp.
  return id === "weekly" || id.endsWith(":weekly") ||
    id === "seven_day" || id.endsWith(":seven_day") ||
    durationSeconds === WEEKLY_SECONDS || durationMinutes === WEEKLY_SECONDS / 60;
}

function percent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) &&
    value >= 0 && value <= 100 ? value : undefined;
}

function remainingPercent(window: RecordValue): number | undefined {
  const used = percent(window.usedPct);
  const remaining = percent(window.remainingPct);
  if (window.usedPct != null && used === undefined) return undefined;
  if (window.remainingPct != null && remaining === undefined) return undefined;
  if (used === undefined && remaining === undefined) return undefined;
  if (used !== undefined && remaining !== undefined && Math.abs((100 - used) - remaining) > 0.5) {
    return undefined;
  }
  return remaining ?? Math.max(0, 100 - used!);
}

function accountKey(sourceId: string, reportId: string): string {
  // CLI account.label is PII; the opaque, stable report ID is the only key used.
  // Domain separation avoids accidental cross-component reuse.
  return createHash("sha256")
    .update("paseo-quota-handoff/account/v1\0")
    .update(sourceId)
    .update("\0")
    .update(reportId)
    .digest("hex");
}

/** Read only the documented Paseo 0.15.3 usage ls --json array. */
export function normalizeQuotaWindows(payload: unknown, now: number, maxAgeMs = DEFAULT_MAX_AGE_MS): QuotaWindows {
  const unknown = (period: QuotaPeriod, reason: string, status: "unknown" | "error" = "unknown"): QuotaSample =>
    ({ status, period, reason });
  const bothUnknown = (reason: string): QuotaWindows => ({
    five_hour: unknown("five_hour", reason), weekly: unknown("weekly", reason),
  });
  if (!Array.isArray(payload)) return bothUnknown("invalid_cli_shape");
  if (!Number.isFinite(now)) return bothUnknown("invalid_clock");
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return bothUnknown("invalid_max_age");

  const matches: Record<QuotaPeriod, Array<{ entry: RecordValue; window: RecordValue }>> = {
    five_hour: [], weekly: [],
  };
  const relevantAccountIdentities = new Set<string>();
  let sourceError = false;
  for (const candidate of payload) {
    if (!record(candidate) || !record(candidate.report)) return bothUnknown("invalid_cli_shape");
    if (candidate.report.status === "error") { sourceError = true; continue; }
    if (candidate.report.status !== "available") continue;
    if (!Array.isArray(candidate.report.windows)) return bothUnknown("invalid_cli_shape");
    for (const window of candidate.report.windows) {
      if (!record(window)) return bothUnknown("invalid_cli_shape");
      const isFive = isFiveHourWindow(window);
      const isWeek = isWeeklyWindow(window);
      // A contradictory named period/duration is not a qualifying window,
      // but still proves that a different report identity is claiming a
      // relevant quota. Do not let malformed period metadata hide an account
      // switch while an otherwise eligible window belongs to the old account.
      const named = typeof window.id === "string" && namedPeriod(window.id) !== null;
      const knownDuration = window.durationSeconds === FIVE_HOUR_SECONDS ||
        window.durationSeconds === WEEKLY_SECONDS ||
        window.durationMinutes === FIVE_HOUR_SECONDS / 60 ||
        window.durationMinutes === WEEKLY_SECONDS / 60;
      if (isFive || isWeek || named || knownDuration) {
        if (typeof candidate.id !== "string" || !candidate.id ||
            typeof candidate.sourceId !== "string" || !candidate.sourceId) {
          return bothUnknown("missing_account_identity");
        }
        // Count identities even for windows with invalid/stale percentages.
        // A second reported account cannot authorize the first account's 5h limit.
        relevantAccountIdentities.add(`${candidate.sourceId}\u0000${candidate.id}`);
        if (relevantAccountIdentities.size > 1) return bothUnknown("conflicting_account_identity");
      }
      if (isFive) matches.five_hour.push({ entry: candidate, window });
      if (isWeek) matches.weekly.push({ entry: candidate, window });
    }
  }

  function one(period: QuotaPeriod): QuotaSample {
    const candidates = matches[period];
    if (candidates.length === 0) return sourceError
      ? unknown(period, "source_error", "error")
      : unknown(period, period === "five_hour" ? "five_hour_missing" : "weekly_missing");
    if (candidates.length > 1) return unknown(period, period === "five_hour" ? "ambiguous_five_hour" : "ambiguous_weekly");
    const { entry, window } = candidates[0];
    if (typeof entry.id !== "string" || !entry.id ||
      typeof entry.sourceId !== "string" || !entry.sourceId ||
      typeof window.id !== "string" || !window.id) {
      return unknown(period, "missing_account_identity");
    }
    const fetchedAt = parseIsoTimestamp(entry.successfulAt ?? entry.fetchedAt);
    if (fetchedAt === undefined) return unknown(period, "invalid_fetched_at");
    if (now - fetchedAt > maxAgeMs || fetchedAt - now > FUTURE_SKEW_MS) {
      return unknown(period, "stale_report");
    }
    const resetTime = parseIsoTimestamp(window.resetsAt);
    if (resetTime === undefined || resetTime <= now) return unknown(period, "invalid_reset");
    const remaining = remainingPercent(window);
    if (remaining === undefined) return unknown(period, "invalid_percent");
    return {
      status: "available", period, sourceId: entry.sourceId,
      accountKey: accountKey(entry.sourceId, entry.id),
      windowId: window.id, resetAt: new Date(resetTime).toISOString(),
      fetchedAt, remainingPercent: remaining,
      durationMinutes: period === "five_hour" ? 300 : 10080,
    };
  }
  const fiveHour = one("five_hour");
  const weekly = one("weekly");
  // An agent-scoped usage report must not combine periods from different accounts.
  // Treat a contradictory provider response as unknown instead of acting on either.
  if (fiveHour.status === "available" && weekly.status === "available" &&
      (fiveHour.sourceId !== weekly.sourceId || fiveHour.accountKey !== weekly.accountKey)) {
    return bothUnknown("conflicting_account_identity");
  }
  return { five_hour: fiveHour, weekly };
}

/** Compatibility adapter for existing single-window callers and fixtures. */
type SingleWindowSample = QuotaSample extends infer S ? S extends { period: QuotaPeriod } ? Omit<S, "period"> : never : never;

function withoutPeriod(sample: QuotaSample): SingleWindowSample {
  if (sample.status === "available") {
    const { period: _period, ...rest } = sample;
    return rest;
  }
  const { period: _period, ...rest } = sample;
  return rest;
}

export function normalizeFiveHourQuota(payload: unknown, now: number, maxAgeMs = DEFAULT_MAX_AGE_MS): SingleWindowSample {
  return withoutPeriod(normalizeQuotaWindows(payload, now, maxAgeMs).five_hour);
}

export function createQuotaWindowReader(options: QuotaReaderOptions = {}) {
  const execute = options.runCli ?? runPaseoCli;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  return async function readAgentQuotaWindows(
    agentId: string,
    forceRefresh = false,
    now = Date.now(),
  ): Promise<QuotaWindows> {
    const unavailable = (status: "unknown" | "error", reason: string): QuotaWindows => ({
      five_hour: { status, period: "five_hour", reason },
      weekly: { status, period: "weekly", reason },
    });
    if (typeof agentId !== "string" || !VALID_AGENT_ID.test(agentId)) {
      return unavailable("unknown", "invalid_agent_id");
    }
    const args = ["usage", "ls", "--agent", agentId, "--json"];
    if (forceRefresh) args.push("--refresh");

    let output: string;
    try {
      output = await execute(args);
    } catch {
      return unavailable("error", "cli_failed");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      return unavailable("unknown", "invalid_cli_json");
    }
    return normalizeQuotaWindows(parsed, now, maxAgeMs);
  };
}

export function createQuotaReader(options: QuotaReaderOptions = {}) {
  const reader = createQuotaWindowReader(options);
  return async (agentId: string, forceRefresh = false, now = Date.now()) =>
    withoutPeriod((await reader(agentId, forceRefresh, now)).five_hour);
}

const defaultReader = createQuotaWindowReader();

export async function readQuotaWindows(agentId: string, forceRefresh = false, now = Date.now()): Promise<QuotaWindows> {
  return defaultReader(agentId, forceRefresh, now);
}

export async function readFiveHour(
  agentId: string,
  forceRefresh = false,
  now = Date.now(),
): Promise<SingleWindowSample> {
  return withoutPeriod((await defaultReader(agentId, forceRefresh, now)).five_hour);
}
