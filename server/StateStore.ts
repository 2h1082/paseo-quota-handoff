import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { QuotaPeriod } from "./Policy";

export type DispatchStage = "claimed" | "accepted" | "verified" | "uncertain";

/** A bounded lock acquisition failed. The caller must not send a handoff. */
export class DispatchStoreLockedError extends Error {
  constructor() { super("dispatch store is locked or unavailable"); }
}

export interface DispatchReceipt {
  id: string;
  key: string;
  /** Other quota windows that reached threshold in the very same dispatch. */
  coveredKeys?: string[];
  agentId: string;
  /** Saved at claim time so file verification survives an archived agent or monitoring OFF. */
  taskProjectRoot?: string;
  stage: DispatchStage;
  claimedAt: number;
  acceptedAt?: number;
  verifiedAt?: number;
  documentPath?: string;
  /** This is a controlled status, never a raw exception or quota account. */
  reason?: string;
}

interface PersistedState { version: 1; receipts: DispatchReceipt[] }

export function dispatchKey(
  host: string, agent: string, source: string, account: string, window: string, reset: string,
  period?: QuotaPeriod,
): string {
  // Period is mandatory for new call sites: providers can report the same
  // generic window ID and reset for 300-minute and 7-day limits. Omission
  // reproduces the legacy hash only when looking up pre-upgrade claims.
  const fields = [host, agent, source, account, window, reset, ...(period ? [period] : [])];
  if (fields.some((field) => !field || field.includes("\u0000"))) throw new Error("invalid dispatch identity");
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

/** The plugin's local daemon home; no user account values or handoff content are persisted. */
export function defaultStateFile(): string {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  return join(home, "plugin-state", "paseo-quota-handoff", "DispatchState.json");
}

export class FileDispatchStore {
  private records: DispatchReceipt[] | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file = defaultStateFile()) {}

  private async load(): Promise<DispatchReceipt[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, "utf8"));
      if (!parsed || typeof parsed !== "object" || (parsed as PersistedState).version !== 1 ||
        !Array.isArray((parsed as PersistedState).receipts)) throw new Error("invalid state version");
      const receipts = (parsed as PersistedState).receipts;
      if (receipts.some((entry) => !entry || typeof entry.key !== "string" ||
        (entry.taskProjectRoot !== undefined && typeof entry.taskProjectRoot !== "string") ||
        !["claimed", "accepted", "verified", "uncertain"].includes(entry.stage))) {
        throw new Error("invalid state receipt");
      }
      this.records = receipts;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.records = [];
    }
    return this.records ?? [];
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = this.file + "." + process.pid + "." + Date.now() + ".tmp";
    await writeFile(temp, JSON.stringify({ version: 1, receipts: this.records ?? [] } satisfies PersistedState), { encoding: "utf8", mode: 0o600 });
    await rename(temp, this.file);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  /** Reclaim only a proven orphan, never a lock held by a live process. */
  private async recoverOrphan(lock: string): Promise<boolean> {
    // Exactly one process may attempt recovery. Otherwise two reclaimers can
    // both observe the old stale lock; after one renames it, the other might
    // accidentally rename a NEW writer's lock at the same path.
    const recoveryGuard = lock + ".recovery";
    try { await mkdir(recoveryGuard); }
    catch { return false; }
    try {
      const lockStat = await stat(lock);
      // The owner may still be writing the metadata immediately after mkdir.
      if (Date.now() - lockStat.mtimeMs < 30_000) return false;
      let ownerPid: number | undefined;
      try {
        const owner: unknown = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
        if (owner && typeof owner === "object") {
          const pid = (owner as { pid?: unknown }).pid;
          if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0) ownerPid = pid;
        }
      } catch { /* A crash before metadata was saved also leaves an orphan. */ }
      if (ownerPid !== undefined) {
        try {
          process.kill(ownerPid, 0);
          return false;
        } catch (error) {
          // EPERM means another process exists but cannot be inspected.
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
        }
      }
      // Atomically move the orphan out of the lock name, so cleanup cannot
      // remove an unrelated newly created lock.
      const orphan = lock + ".orphan." + randomUUID();
      await rename(lock, orphan);
      await rm(orphan, { recursive: true, force: true });
      return true;
    } catch { return false; }
    finally { await rmdir(recoveryGuard).catch(() => undefined); }
  }

  /** The directory creation is atomic across plugin subprocesses and reloads. */
  private async exclusively<T>(operation: () => Promise<T>): Promise<T> {
    const lock = this.file + ".lock";
    await mkdir(dirname(this.file), { recursive: true });
    const deadline = Date.now() + 3_000;
    while (true) {
      try {
        await mkdir(lock);
        await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }), "utf8");
        break;
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) {
          throw new DispatchStoreLockedError();
        }
        if (await this.recoverOrphan(lock)) continue;
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      // Always consult the disk under the cross-process lock; cached records
      // from a previous plugin instance cannot authorize another send.
      this.records = null;
      return await operation();
    } finally {
      await rm(join(lock, "owner.json"), { force: true });
      await rmdir(lock);
    }
  }

  async get(key: string): Promise<DispatchReceipt | undefined> {
    return this.serialize(async () => (await this.load()).find((entry) => entry.key === key || entry.coveredKeys?.includes(key)));
  }

  async list(): Promise<DispatchReceipt[]> {
    return this.serialize(async () => (await this.load()).map((entry) => ({ ...entry })));
  }

  async claim(receipt: Omit<DispatchReceipt, "stage">): Promise<boolean> {
    return this.claimGroup(receipt, []);
  }

  /** Atomically reserve multiple active quota windows for one outgoing message. */
  async claimGroup(receipt: Omit<DispatchReceipt, "stage">, coveredKeys: string[]): Promise<boolean> {
    return this.serialize(() => this.exclusively(async () => {
      const records = await this.load();
      const incoming = new Set([receipt.key, ...coveredKeys]);
      if (incoming.size !== coveredKeys.length + 1) throw new Error("duplicate quota keys in claim");
      if (records.some((entry) => [entry.key, ...(entry.coveredKeys ?? [])].some((key) => incoming.has(key)))) return false;
      records.push({ ...receipt, coveredKeys: [...coveredKeys], stage: "claimed" });
      await this.persist();
      return true;
    }));
  }

  async update(key: string, stage: DispatchStage, fields: Partial<Pick<DispatchReceipt, "acceptedAt" | "verifiedAt" | "documentPath" | "taskProjectRoot" | "reason">> = {}): Promise<void> {
    await this.serialize(() => this.exclusively(async () => {
      const found = (await this.load()).find((entry) => entry.key === key || entry.coveredKeys?.includes(key));
      if (!found) throw new Error("unknown dispatch claim");
      if (found.stage === "verified" && stage !== "verified") throw new Error("verified claim cannot regress");
      Object.assign(found, fields, { stage });
      await this.persist();
    }));
  }

  /** Claim was never sent because monitoring was switched off before dispatch. */
  async cancelUnsent(key: string): Promise<void> {
    await this.serialize(() => this.exclusively(async () => {
      const records = await this.load();
      const idx = records.findIndex((entry) => (entry.key === key || entry.coveredKeys?.includes(key)) && entry.stage === "claimed");
      if (idx >= 0) { records.splice(idx, 1); await this.persist(); }
    }));
  }
}
