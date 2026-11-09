import { readFile, stat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { existsSync } from "node:fs";

export type HandoffResult =
  | { status: "saved"; path: string }
  | { status: "failed"; reason: string };

/** Read only a complete agent response, never a copy of the outgoing user prompt. */
export function extractHandoffResult(output: string, dispatchId: string): HandoffResult | null {
  const lines = output.split(/\r?\n/).filter((line) => line.includes("HANDOFF_RESULT:"));
  for (const line of lines.reverse()) {
    const marker = line.indexOf("HANDOFF_RESULT:");
    try {
      const parsed = JSON.parse(line.slice(marker + "HANDOFF_RESULT:".length).trim()) as Record<string, unknown>;
      if (parsed.dispatchId !== dispatchId) continue;
      if (parsed.status === "saved" && typeof parsed.path === "string" && parsed.path.trim()) {
        return { status: "saved", path: parsed.path.trim() };
      }
      if (parsed.status === "failed") {
        return { status: "failed", reason: "agent-reported-save-failure" };
      }
    } catch { /* malformed or unrelated output cannot prove a write */ }
  }
  return null;
}

function isWithin(parent: string, child: string): boolean {
  const diff = relative(parent, child);
  return diff === "" || (diff !== ".." && !diff.startsWith(".." + sep) && !isAbsolute(diff));
}

/** Find the closest project boundary, preferring local AGENTS over a larger mono-repo. */
export function findTaskProjectRoot(cwd: string): string | null {
  if (!cwd || !isAbsolute(cwd)) return null;
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, "AGENTS.md")) || existsSync(join(current, ".git"))) return current;
    const next = dirname(current);
    if (next === current) return null;
    current = next;
  }
}

/**
 * Agent-reported paths are hints only. Verification requires an actual readable,
 * recently written Markdown file inside the agent's own task project.
 */
export async function verifyHandoffFile(
  agentCwd: string,
  reportedPath: string,
  acceptedAt: number,
): Promise<string | null> {
  const workspaceRoot = findTaskProjectRoot(agentCwd);
  if (!workspaceRoot) return null;
  const absolute = isAbsolute(reportedPath)
    ? resolve(reportedPath) : resolve(workspaceRoot, reportedPath);
  // The active task may belong to a nested independent project while the
  // agent's working directory points at a larger multi-project workspace.
  // Accept only a real project boundary (AGENTS.md/.git) *within* the agent's
  // trusted checkout, never an arbitrary sibling or a temporary directory.
  const root = findTaskProjectRoot(dirname(dirname(dirname(absolute))));
  if (!root || !isWithin(workspaceRoot, root)) return null;
  const handoffs = resolve(root, "Docs", "Handoffs");
  if (!isWithin(handoffs, absolute) || absolute === handoffs ||
    !basename(absolute).toLowerCase().endsWith(".md")) return null;
  try {
    const [canonicalWorkspace, canonicalRoot, canonicalHandoffs, canonicalPath] = await Promise.all([
      realpath(workspaceRoot), realpath(root), realpath(handoffs), realpath(absolute),
    ]);
    if (!isWithin(canonicalWorkspace, canonicalRoot) ||
      !isWithin(canonicalRoot, canonicalHandoffs) ||
      !isWithin(canonicalHandoffs, canonicalPath)) return null;
    const metadata = await stat(absolute);
    if (!metadata.isFile() || metadata.size < 100 || metadata.size > 2_000_000 ||
      metadata.mtimeMs < acceptedAt - 2_000) return null;
    const content = await readFile(absolute, "utf8");
    const required = [
      /suggested skills|추천\s*스킬/i,
      /decision|choice|결정|판단|선택/i,
      /pending|remaining|next steps|next task|남은|미완|다음|후속/i,
      /verification|test result|validation|검증|테스트/i,
      /reference|artifact|related|file path|issue|commit|참조|산출물|경로|파일/i,
    ];
    if (!/^\s*#\s+\S/m.test(content) || required.some((pattern) => !pattern.test(content))) return null;
    if (/\b(?:sk-[A-Za-z0-9_-]{24,}|ghp_[A-Za-z0-9]{24,})\b/.test(content)) return null;
    return absolute;
  } catch { return null; }
}
