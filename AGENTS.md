---
id: paseo-quota-handoff
name: Paseo Quota Handoff
type: automation
domain: SoftwareDevelopment
payload_path: .
roadmap_source: github
task_source: github
knowledge_source: none
knowledge_domains: SoftwareDevelopment, AIEngineering
---

# Paseo Quota Handoff Project Instructions

## Project Context

GitHub Issues are the execution queue; select and track implementation work there.

No separate project knowledge source is configured.

This file is the project-local orientation guide. Keep detailed workflows in
the matching skill, project doc, or source/config file instead of duplicating
them here.

## Before Work

1. Follow the task source and project settings above.
2. Follow the configured knowledge source when the task depends on plans,
   specs, decisions, backlog, QA, meetings, or handoffs.
   Identify the task-relevant subset of `knowledge_domains` before committing to a
   technical approach; search those Wikis and cite relevant facts in project decisions.
3. Inspect the existing payload under `./` before assuming framework, module, asset, or config paths.
4. Keep changes focused and report any verification commands or manual checks
   that were not run.

## Search and Exploration

- Project knowledge search: follow the configured knowledge source above. When
  it provides local Docs or a Notion mirror, use QMD for broad Markdown
  retrieval when a local `.qmd` config is available.
- Reusable knowledge search: `knowledge_domains` is a comma-separated list,
  distinct from the single ownership `domain`. For each task, search the relevant
  subset of declared domain Wikis rather than assuming every topic belongs to
  `SoftwareDevelopment` or reading all Wikis indiscriminately. With project-local
  QMD, the first domain uses `Wiki`; additional domains as `Wiki-<Domain>`.
  Check actual Wiki sources and project decisions before applying a pattern; a
  domain Wiki is not the project's current implementation state. If QMD is
  unavailable, follow the corresponding repository Wiki files and report gaps.
- Codebase exploration: inspect `./` directly and use Graphify or
  another code graph tool for structure, relationships, and impact leads; use
  `graphify-workflow` for Graphify-based code navigation. Verify graph results
  against actual source before editing.

## Project Boundaries

- Keep durable project notes in docs under `Docs/` and `./`.
- Do not add project-local external-system mirrors unless the project explicitly
  needs them.
- Promote reusable knowledge to its **subject-matter domain** Wiki (not
  necessarily `SoftwareDevelopment`) only when explicitly asked. Keep
  project-specific decisions in project Docs.
