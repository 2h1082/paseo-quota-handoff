import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Host-owned operator choices. Safe OFF + dry-run defaults survive reinstall. */
export const monitorSettings = defineSettings({
  id: "monitor",
  scope: "host",
  version: 3,
  migrate: (values: unknown, fromVersion: number): unknown => {
    if ((fromVersion !== 1 && fromVersion !== 2) || !values || typeof values !== "object") return values;
    const previous = values as Record<string, unknown>;
    if (fromVersion === 2) return { ...previous, activeTurnMode: "steer" };
    return {
      ...previous,
      activeTurnMode: "steer",
      fiveHour: {
        enabled: true,
        remainingThresholdPercent: typeof previous.remainingThresholdPercent === "number"
          ? previous.remainingThresholdPercent : 10,
      },
      // v1 had no weekly monitoring. Preserve the operator's prior scope on upgrade.
      weekly: { enabled: false, remainingThresholdPercent: 10 },
    };
  },
  schema: z.object({
    enabled: z.boolean().default(false),
    dryRun: z.boolean().default(true),
    activeTurnMode: z.enum(["steer", "defer"]).default("steer"),
    fiveHour: z.object({
      enabled: z.boolean().default(true),
      remainingThresholdPercent: z.number().finite().min(0).max(100).default(10),
    }).default({ enabled: true, remainingThresholdPercent: 10 }),
    weekly: z.object({
      enabled: z.boolean().default(true),
      remainingThresholdPercent: z.number().finite().min(0).max(100).default(10),
    }).default({ enabled: true, remainingThresholdPercent: 10 }),
    pollIntervalSeconds: z.number().int().min(30).max(3600).default(60),
    includeChildAgents: z.boolean().default(false),
    targetAgentIds: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  }),
});

export type MonitorSettingsValues = z.infer<typeof monitorSettings.schema>;
