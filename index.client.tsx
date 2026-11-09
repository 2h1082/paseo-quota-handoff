import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SettingsScreen } from "./client/SettingsScreen";

export default function contribute(client: PluginClientContext) {
  const remove = client.addSettingsScreen({
    id: "quota-handoff-settings",
    title: "Quota Handoff",
    icon: "Gauge",
    Component: SettingsScreen,
  });
  return remove;
}
