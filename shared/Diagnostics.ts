import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const monitorDiagnosticsRpc = defineRpc({
  name: "quota-monitor.diagnostics",
  input: z.object({}),
  output: z.object({
    lastScanAt: z.number().nullable(),
    busy: z.boolean(),
    scanError: z.string().nullable(),
    agents: z.array(z.object({
      agentId: z.string(),
      status: z.enum(["unknown", "skipped", "candidate", "deferred", "claimed", "accepted", "verified", "uncertain"]),
      lastFetchedAt: z.number().optional(),
      remainingPercent: z.number().optional(),
      periods: z.array(z.object({
        period: z.enum(["five_hour", "weekly"]),
        status: z.enum(["available", "unknown", "error", "disabled"]),
        remainingPercent: z.number().optional(),
        thresholdPercent: z.number(),
        fetchedAt: z.number().optional(),
        resetAt: z.string().optional(),
        candidate: z.boolean(),
        reason: z.string().optional(),
      })).optional(),
      lastAttemptAt: z.number().optional(),
      documentPath: z.string().optional(),
      lastDispatchStage: z.enum(["claimed", "accepted", "verified", "uncertain"]).optional(),
      lastVerifiedDocument: z.string().optional(),
      reason: z.string().optional(),
    })),
  }),
});
