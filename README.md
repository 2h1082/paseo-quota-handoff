# Paseo Quota Handoff

[![Plugin CI](https://github.com/2h1082/paseo-quota-handoff/actions/workflows/ci.yml/badge.svg)](https://github.com/2h1082/paseo-quota-handoff/actions/workflows/ci.yml)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

**An opt-in [Paseo](https://paseo.sh/) daemon plugin that asks your running AI agent to save a task handoff before its account quota runs low.**

Monitor the account's **five-hour and weekly quota windows** independently. When an enabled window crosses its configured **remaining quota** threshold, the plugin asks the *existing* agent to record its progress as Markdown in the **task-owning project's** `Docs/Handoffs/` directory. It then checks that the file was actually saved. No separate agent, account switcher, or installed handoff skill is required.

> **Safe by default:** Monitoring starts **OFF**, and dry-run starts **ON**. Installing the plugin does not send messages to agents. Enable real handoffs only after reviewing the settings and testing with a disposable agent.

## Features

- **Independent thresholds:** Enable/disable five-hour and weekly quota monitoring separately; configure either remaining threshold from 0% to 100% (10% by default).
- **Account-aware checks:** Read usage for the current agent's account; reject missing, stale, conflicting, or unidentifiable quota reports rather than guessing.
- **Active-turn handoff:** Prefer Paseo's native `steer` support for a running agent, or select `defer` to wait until it is idle. Native steering can fall back to interruption on some providers.
- **One request per quota window:** Persist dispatch claims, combine simultaneous five-hour/weekly triggers, and avoid blind resends after ambiguous transport outcomes.
- **Verified Markdown:** Distinguish a requested/accepted handoff from a readable handoff document. Reports are marked `verified` only after independent file readback.
- **Desktop settings:** Control monitoring, dry-run, periods, percentages, poll interval, agent filters, and child-agent inclusion through Paseo's plugin settings screen.

## Requirements

- [Paseo Desktop / daemon](https://paseo.sh/) **0.15.3 or later**, with a compatible plugin runtime and the Paseo CLI.
- [Node.js](https://nodejs.org/) **24** and npm to run the included development checks.
- An agent with a reportable account-level five-hour or weekly quota window. Some account/provider combinations do not expose these windows and will remain `UNKNOWN`.

This version was developed and checked against **Paseo 0.15.3 on Windows**, including a real native Codex handoff and automated integration tests. Other OS/provider combinations have not all been verified live.

## Install

Clone this repository and install the plugin **from its source directory**. In PowerShell:

```powershell
git clone https://github.com/2h1082/paseo-quota-handoff.git
cd paseo-quota-handoff
npm ci --ignore-scripts
npm run typecheck
npm test
paseo plugin install (Get-Location).Path
paseo plugin ls
```

If `paseo` is not on your Windows PATH, invoke the CLI bundled with Paseo Desktop instead:

```powershell
& "$env:LOCALAPPDATA\Programs\Paseo\resources\bin\paseo.cmd" plugin install (Get-Location).Path
```

The monitor also attempts to discover the standard Desktop installation. If your CLI is elsewhere, configure `PASEO_CLI` in the daemon's environment to point to its executable. Use the CLI associated with the *same daemon* that is running the agents.

## First-run configuration

In Paseo, open **Settings → Plugins → Paseo Quota Handoff → Settings**.

| Setting | Default | Meaning |
| --- | --- | --- |
| Monitoring | **OFF** | Master switch for quota polling and new handoff requests |
| Dry-run | **ON** | Detect candidates without sending agent messages |
| Five-hour window | ON, **10% remaining** | Trigger threshold for a valid 300-minute account window |
| Weekly window | ON, **10% remaining** | Trigger threshold for a valid seven-day account window |
| Poll interval | **60 seconds** | Regular checks; upstream usage caching may delay new values |
| Steer running agents | **ON** | Ask the agent to checkpoint during a turn; may interrupt on fallback |
| Child agents | **OFF** | Target main agents unless explicitly enabled |
| Target agent IDs | Empty | Empty targets all eligible agents on this daemon; IDs narrow the scope |

Recommended rollout:

1. Enter the ID of a **disposable test agent** in the target list.
2. Set **Monitoring ON** while keeping **Dry-run ON**. Confirm the reported quota windows and diagnostics.
3. For a controlled test, switch **Dry-run OFF** with only that test agent targeted. Confirm a handoff file is produced and marked `verified`.
4. Set your desired thresholds and agent scope. If active-turn interruption is unacceptable, turn off **Steer running agents** to defer until idle.

For long-running tasks, earlier remaining thresholds such as **20% (five-hour)** and **15% (weekly)** give the agent more room to checkpoint. These are recommendations, not default settings or timing guarantees.

## What happens at the threshold?

```text
Paseo agent-scoped usage
        ↓
Validate window, account, timestamp and threshold
        ↓
Reserve a durable, deduplicated handoff dispatch
        ↓
Steer an active agent (or defer until idle)
        ↓
Agent saves <task project>/Docs/Handoffs/*.md
        ↓
Verify that the referenced Markdown exists and is readable
```

The bundled instructions ask the agent to preserve the task's goals, decisions, completed work, pending items, review/test evidence, and relevant file or issue links. They explicitly require **redacting credentials and personal information**. These instructions are maintained in this repository; the plugin does **not** fetch a separate private skill or require a skill to be installed in the target agent.

The settings distinguish `candidate` (dry-run), `claimed` (reserved), `accepted` (message accepted), `uncertain` (delivery cannot safely be retried), and `verified` (handoff file checked). A simultaneous five-hour and weekly crossing produces **one** request covering both windows.

## Operations and recovery

```powershell
paseo plugin ls
paseo plugin reload paseo-quota-handoff
paseo plugin disable paseo-quota-handoff
paseo plugin enable paseo-quota-handoff
paseo plugin remove paseo-quota-handoff
```

Monitoring OFF stops new quota checks and requests. Previously accepted handoffs can continue to be checked read-only. The daemon stores deduplication state under `plugin-state/paseo-quota-handoff/DispatchState.json` in its own data directory. **Preserve that file across reinstalls/restarts** if you want to avoid repeat requests within the same quota window.

If a crash leaves the dispatch store locked, stop/disable the plugin and verify no previous writer is active before investigating the lock directory. Never remove a live writer's lock or discard the state file just to clear a warning.

The plugin **does not switch accounts, launch a new agent, bypass quotas, or automatically resume a chat under a different account**. It can coexist with other account-management plugins, but those plugins' continuation and token-use behavior is independent.

## Limitations

- The quota API may be cached, and the polling interval is not a strict deadline. Thresholds are evaluated from **reported account quota**, not a model's remaining context window.
- Provider responses without a unique account identity, valid reset time, fresh sample, or explicit supported window are ignored for that window.
- Native `steer` is **best effort**, and Paseo may fall back to interrupting an in-progress turn. Select `defer` when avoiding interruption matters more than finishing before quota exhaustion.
- A final account switch racing with the delivery acknowledgment cannot be made atomic across independent systems. A file is never marked `verified` solely because a message was accepted.
- Host-local dispatch state does not coordinate multiple independent Paseo daemons. Cross-provider live steering and every runtime-reload race have not been exhaustively exercised.

## Development

```powershell
npm ci --ignore-scripts
npm run typecheck
npm test
npm pack --dry-run
```

The tests cover quota parsing, independent period decisions, account changes, deduplication, restart recovery, delivery and file verification, settings migration, and UI state handling. CI runs these checks on Windows. The package is marked `private` to prevent accidental npm publication; **GitHub source distribution is supported**.

```text
client/             Paseo settings UI
server/             Quota reader, policy, dispatch coordination and verification
shared/             Settings and diagnostic contracts
tests/              Automated regression and integration tests
index.server.ts     Daemon plugin entry
index.client.tsx    Client plugin entry
paseo-plugin.json   Paseo plugin manifest
```

## Security and privacy

Only install plugins from source you trust: the daemon plugin can invoke Paseo's local CLI and send messages to agents. Review the code, keep the monitor disabled until you configure it, and use an isolated test agent first. Routine diagnostics do not intentionally log account credentials or raw usage payloads; the generated handoff is created in the agent's **own project**, not in this plugin's repository.

If you discover a security issue, avoid posting credentials or private logs in a public GitHub issue. Use a private contact channel or GitHub's private vulnerability reporting feature where available.

## License

[MIT License](LICENSE) — Copyright (c) 2026 2h1082.
