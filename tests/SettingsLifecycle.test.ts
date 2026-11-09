import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { DEFAULT_CONFIG } from "../server/Policy";

test("transient startup settings failures fail closed and recover monitoring setup", async () => {
  const folder = await mkdtemp(join(tmpdir(), "paseo-settings-recovery-"));
  const originalHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = folder;
  let cleanup: (() => void) | undefined;
  try {
    let reads = 0;
    let diagnostics!: () => Promise<{ scanError: string | null }>;
    const fakeSettings = {
      read: async () => {
        reads += 1;
        if (reads <= 2) throw new Error("transient settings storage failure - private error");
        return { status: "ready" as const, revision: "ready-revision",
          values: { ...DEFAULT_CONFIG, enabled: false } };
      },
      subscribe: () => () => {},
    };
    const fakeServer = {
      registerSettings: () => fakeSettings,
      addHook: () => () => {},
      handle: (_rpc: unknown, handler: () => Promise<{ scanError: string | null }>) => {
        diagnostics = handler;
      },
    } as unknown as PluginServerContext;
    cleanup = contribute(fakeServer);

    await new Promise<void>((resolve) => setTimeout(resolve, 75));
    assert.ok(reads >= 2, "startup must invoke the fail-closed settings recovery path");
    assert.equal((await diagnostics()).scanError, "settings-unavailable");

    await new Promise<void>((resolve) => setTimeout(resolve, 2_150));
    assert.ok(reads >= 3, "retry must occur without an operator toggle or reload");
    assert.equal((await diagnostics()).scanError, null);
  } finally {
    cleanup?.();
    if (originalHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = originalHome;
    await rm(folder, { recursive: true, force: true });
  }
});
