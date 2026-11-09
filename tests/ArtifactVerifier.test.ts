import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { extractHandoffResult, findTaskProjectRoot, verifyHandoffFile } from "../server/ArtifactVerifier";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function project() {
  const root = await mkdtemp(join(tmpdir(), "paseo-handoff-test-"));
  dirs.push(root);
  await writeFile(join(root, "AGENTS.md"), "# Test project\n");
  await mkdir(join(root, "src"));
  await mkdir(join(root, "Docs", "Handoffs"), { recursive: true });
  return root;
}

test("matches only the sent dispatch ID and accepts a real JSON result", () => {
  const output = [
    'HANDOFF_RESULT: {"dispatchId":"unrelated","status":"saved","path":"ignore.md"}',
    'HANDOFF_RESULT: {"dispatchId":"our-id","status":"failed","reason":"cannot write"}',
  ].join("\n");
  assert.deepEqual(extractHandoffResult(output, "our-id"), { status: "failed", reason: "agent-reported-save-failure" });
  assert.equal(extractHandoffResult(output, "missing-id"), null);
  assert.equal(extractHandoffResult('HANDOFF_RESULT: {not-json}', "our-id"), null);
});

test("artifact is verified only when actually readable in the task owner's Docs/Handoffs", async () => {
  const root = await project();
  assert.equal(findTaskProjectRoot(join(root, "src")), root);
  const doc = join(root, "Docs", "Handoffs", "CurrentTask.md");
  const acceptedAt = Date.now();
  assert.equal(await verifyHandoffFile(join(root, "src"), doc, acceptedAt), null);
  await writeFile(doc, "# Current task handoff\n\n## Suggested skills\n- /code-review\n\n## Decisions\n- Keep the approved API.\n\n## Next steps and pending work\n- Finish implementation.\n\n## Verification\n- Tests passed.\n\n## References\n- Docs/Plans/Plan.md\n");
  assert.equal(await verifyHandoffFile(join(root, "src"), doc, acceptedAt), doc);
  assert.match(await readFile(doc, "utf8"), /Suggested skills/);
});

test("outside paths and stale files never become verified handoffs", async () => {
  const root = await project();
  const rootOut = join(root, "Elsewhere.md");
  const doc = join(root, "Docs", "Handoffs", "Old.md");
  const content = "# Old handoff\n\n## Suggested skills\n- /review\n\n## Decisions\n- Defer release.\n\n## Next steps\n- Carry pending work forward.\n\n## Verification\n- Existing tests passed.\n\n## References\n- Docs/Plans/Plan.md\n";
  await writeFile(rootOut, content);
  await writeFile(doc, content);
  const past = new Date(Date.now() - 3600_000);
  await utimes(doc, past, past);
  const acceptedAt = Date.now();
  assert.equal(await verifyHandoffFile(root, rootOut, acceptedAt), null);
  assert.equal(await verifyHandoffFile(root, doc, acceptedAt), null);
  assert.equal(await verifyHandoffFile(root, "Docs/Handoffs/Missing.md", acceptedAt), null);
});

test("a misleading saved path with incomplete content is not independently verified", async () => {
  const root = await project();
  const path = join(root, "Docs", "Handoffs", "Incomplete.md");
  await writeFile(path, "# Current task\n\n## Suggested skills\n- /pr\n\n## Next steps\n- Continue implementation.\n".repeat(3));
  assert.equal(await verifyHandoffFile(root, path, Date.now()), null);
});

test("a nested task-owning project is verified under a larger agent workspace", async () => {
  const root = await project();
  const nested = join(root, "SoftwareDevelopment", "Projects", "TaskOwner");
  await mkdir(join(nested, "Docs", "Handoffs"), { recursive: true });
  await writeFile(join(nested, "AGENTS.md"), "# Actual task owner\n");
  const path = join(nested, "Docs", "Handoffs", "CurrentTask.md");
  await writeFile(path, "# Current task handoff\n\n## Suggested skills\n- /code-review\n\n## Decisions\n- Keep the approved API.\n\n## Next steps and pending work\n- Finish implementation.\n\n## Verification\n- Tests passed.\n\n## References\n- Docs/Plans/Plan.md\n");
  assert.equal(await verifyHandoffFile(root, path, Date.now()), path);
});
