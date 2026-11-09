import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { monitorSettings } from "../shared/Settings";
import { monitorDiagnosticsRpc } from "../shared/Diagnostics";

function formatTime(timestamp: number | null | undefined): string {
  return timestamp == null ? "—" : new Date(timestamp).toLocaleString();
}

export function SettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(monitorSettings);
  const diagnosticsRpc = useRpc(monitorDiagnosticsRpc);
  const diagnostics = useQuery({
    queryKey: ["paseo-quota-handoff", "diagnostics"],
    queryFn: () => diagnosticsRpc({}),
    refetchInterval: 30_000,
  });
  const [fiveHourThreshold, setFiveHourThreshold] = useState("10");
  const [weeklyThreshold, setWeeklyThreshold] = useState("10");
  const [interval, setInterval] = useState("60");
  const [targets, setTargets] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Toggle saves change the server revision; they must not discard unsaved text fields.
  const dirtyFields = useRef(new Set<string>());
  const editCounts = useRef({ five: 0, weekly: 0, interval: 0, targets: 0 });
  const markEdited = (field: keyof typeof editCounts.current) => {
    editCounts.current[field]++;
    dirtyFields.current.add(field);
  };
  const revision = settings.status === "ready" ? settings.revision : "";

  useEffect(() => {
    if (settings.status !== "ready") return;
    if (!dirtyFields.current.has("five")) setFiveHourThreshold(String(settings.values.fiveHour.remainingThresholdPercent));
    if (!dirtyFields.current.has("weekly")) setWeeklyThreshold(String(settings.values.weekly.remainingThresholdPercent));
    if (!dirtyFields.current.has("interval")) setInterval(String(settings.values.pollIntervalSeconds));
    if (!dirtyFields.current.has("targets")) setTargets(settings.values.targetAgentIds.join(", "));
    setError(null);
  }, [revision]);

  const styles = useMemo(() => ({
    main: { gap: layout.compact ? 12 : 20, paddingVertical: 12 },
    text: { color: theme.colors.foreground },
    muted: { color: theme.colors.foregroundMuted },
    error: { color: theme.colors.statusDanger },
    diagnostic: { padding: 12, gap: 4, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  }), [theme, layout.compact]);

  if (settings.status !== "ready") {
    return <View style={styles.main}>
      <Text style={styles.text}>{settings.status === "loading" ? "Loading monitor settings…" : "Settings unavailable. Resolve stored settings before enabling monitoring."}</Text>
      {settings.status === "invalid" && <SettingsAction label="Restore safe defaults" actionLabel="Reset" onPress={() => { void settings.reset(); }} />}
      {settings.status === "error" && <SettingsAction label="Reconnect settings" actionLabel="Retry" onPress={() => { void settings.reload(); }} />}
    </View>;
  }

  const values = settings.values;
  const save = (next: typeof values) => { void settings.save(next, settings.revision); };
  const saveDetailedSettings = async () => {
    const nextFiveHour = Number(fiveHourThreshold.trim());
    const nextWeekly = Number(weeklyThreshold.trim());
    const nextInterval = Number(interval.trim());
    const nextTargets = targets.split(",").map((x) => x.trim()).filter(Boolean);
    if (!fiveHourThreshold.trim() || !Number.isFinite(nextFiveHour) || nextFiveHour < 0 || nextFiveHour > 100) {
      setError("Five-hour remaining threshold must be between 0% and 100%.");
      return;
    }
    if (!weeklyThreshold.trim() || !Number.isFinite(nextWeekly) || nextWeekly < 0 || nextWeekly > 100) {
      setError("Weekly remaining threshold must be between 0% and 100%.");
      return;
    }
    if (!/^[0-9]+$/.test(interval.trim()) || !Number.isInteger(nextInterval) || nextInterval < 30 || nextInterval > 3600) {
      setError("Polling interval must be 30–3600 seconds.");
      return;
    }
    if (nextTargets.length > 50 || nextTargets.some((target) => target.length > 200)) {
      setError("Specify at most 50 valid agent IDs.");
      return;
    }
    setError(null);
    const submittedEdits = { ...editCounts.current };
    const saved = await settings.save({ ...values,
      fiveHour: { ...values.fiveHour, remainingThresholdPercent: nextFiveHour },
      weekly: { ...values.weekly, remainingThresholdPercent: nextWeekly },
      pollIntervalSeconds: nextInterval, targetAgentIds: nextTargets,
    }, settings.revision);
    if (saved) {
      // A field edited while the save was pending is a new unsaved draft.
      // Do not clear its dirty flag and overwrite it on the next revision.
      for (const field of Object.keys(submittedEdits) as Array<keyof typeof submittedEdits>) {
        if (editCounts.current[field] === submittedEdits[field]) dirtyFields.current.delete(field);
      }
    }
  };

  return <View style={styles.main}>
    <SettingsSection title="Quota handoff monitoring" info="Checks the current account's explicitly reported five-hour and weekly quota windows. Monitoring starts OFF; dry-run never messages an agent.">
      <SettingsCard>
        <SettingsSwitch label="Monitoring enabled" hint="OFF immediately stops checks and new messages" value={values.enabled} onValueChange={(enabled) => save({ ...values, enabled })} />
        <SettingsSwitch label="Dry-run only" hint="Record candidates without sending handoff instructions" value={values.dryRun} onValueChange={(dryRun) => save({ ...values, dryRun })} />
        <SettingsSwitch label="Steer running agents" hint="Send a handoff request into an active Codex, Claude, OpenCode or Pi turn. Paseo may interrupt if native steering is unavailable; OFF waits for an idle turn." value={values.activeTurnMode === "steer"} onValueChange={(enabled) => save({ ...values, activeTurnMode: enabled ? "steer" : "defer" })} />
        <SettingsSwitch label="Include child agents" hint="Off includes parent agents only" value={values.includeChildAgents} onValueChange={(includeChildAgents) => save({ ...values, includeChildAgents })} />
      </SettingsCard>
    </SettingsSection>
    <SettingsSection title="Independent quota limits" info="Enable either period or both. Each triggers at or below its own remaining percentage, inclusive. A simultaneous trigger generates one handoff request.">
      <SettingsCard>
        <SettingsSwitch label="Five-hour limit" hint="Current account's 300-minute window" value={values.fiveHour.enabled} onValueChange={(enabled) => save({ ...values, fiveHour: { ...values.fiveHour, enabled } })} />
        <SettingsInput key={revision + ":five-hour"} label="Five-hour remaining threshold (%)" initialValue={dirtyFields.current.has("five") ? fiveHourThreshold : String(values.fiveHour.remainingThresholdPercent)} onChangeText={(text) => { markEdited("five"); setFiveHourThreshold(text); }} placeholder="10" />
        <SettingsSwitch label="Weekly limit" hint="Current account's seven-day window" value={values.weekly.enabled} onValueChange={(enabled) => save({ ...values, weekly: { ...values.weekly, enabled } })} />
        <SettingsInput key={revision + ":weekly"} label="Weekly remaining threshold (%)" initialValue={dirtyFields.current.has("weekly") ? weeklyThreshold : String(values.weekly.remainingThresholdPercent)} onChangeText={(text) => { markEdited("weekly"); setWeeklyThreshold(text); }} placeholder="10" />
      </SettingsCard>
    </SettingsSection>
    <SettingsSection title="Polling and targets">
      <SettingsCard>
        <SettingsInput key={revision + ":interval"} label="Polling interval (seconds)" initialValue={dirtyFields.current.has("interval") ? interval : String(values.pollIntervalSeconds)} onChangeText={(text) => { markEdited("interval"); setInterval(text); }} placeholder="60" />
        <SettingsInput key={revision + ":targets"} label="Agent IDs (comma separated, blank = all)" initialValue={dirtyFields.current.has("targets") ? targets : values.targetAgentIds.join(", ")} onChangeText={(text) => { markEdited("targets"); setTargets(text); }} placeholder="All eligible agents" />
        <SettingsAction label="Apply configuration" actionLabel="Save" onPress={() => { void saveDetailedSettings(); }} />
      </SettingsCard>
      {error && <Text style={styles.error}>{error}</Text>}
      {settings.saveError && <Text style={styles.error}>{settings.saveError}</Text>}
    </SettingsSection>
    <SettingsSection title="Diagnostics" info="Five-hour and weekly values are shown separately. Provider reports may be cached for roughly five minutes; accepted means delivery and verified requires a readable Markdown file.">
      <SettingsCard>
        <SettingsRow label="Last scan" hint={formatTime(diagnostics.data?.lastScanAt)} />
        <SettingsRow label="Monitor" hint={values.enabled ? (diagnostics.data?.busy ? "Checking" : "Enabled") : "OFF"} />
        {diagnostics.data?.scanError && <SettingsRow label="Latest scan error" hint={diagnostics.data.scanError} />}
        <SettingsAction label="Refresh status" actionLabel="Refresh" onPress={() => { void diagnostics.refetch(); }} />
      </SettingsCard>
      {diagnostics.isError && <Text style={styles.error}>Diagnostics unavailable.</Text>}
      {diagnostics.data?.agents.map((agent) => <View key={agent.agentId} style={styles.diagnostic}>
        <Text style={styles.text}>{agent.agentId}: {agent.status.toUpperCase()}</Text>
        {agent.periods?.map((period) => <Text key={period.period} style={styles.muted}>
          {period.period === "five_hour" ? "Five-hour" : "Weekly"}: {period.status === "available" ? `${period.remainingPercent}% remaining` : period.status.toUpperCase()}
          {` · Trigger ≤${period.thresholdPercent}% · Fetched ${formatTime(period.fetchedAt)}`}
          {period.resetAt ? ` · Reset ${new Date(period.resetAt).toLocaleString()}` : ""}
          {period.candidate ? " · candidate" : ""}
        </Text>)}
        {!!agent.reason && <Text style={styles.muted}>Reason: {agent.reason}</Text>}
        {agent.lastDispatchStage && <Text style={styles.muted}>Last request: {agent.lastDispatchStage.toUpperCase()} · {formatTime(agent.lastAttemptAt)}</Text>}
        {!!(agent.lastVerifiedDocument ?? agent.documentPath) && <Text style={styles.muted}>Verified handoff: {agent.lastVerifiedDocument ?? agent.documentPath}</Text>}
      </View>)}
    </SettingsSection>
  </View>;
}
