import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Exercise the shipped CLI, Skill and Hook entry points with an isolated, disposable Vault.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await mkdtemp(join(root, ".distribution-"));
const run = (script, args, input, env = {}) => {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: fixture, input, encoding: "utf8", timeout: 10000,
    env: { ...process.env, ...env },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};
const inventory = async dir => {
  const result = [];
  const walk = async (current, prefix = "") => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name), relative = prefix + entry.name;
      if (entry.isDirectory()) await walk(path, relative + "/");
      else result.push([relative, createHash("sha256").update(await readFile(path)).digest("hex")]);
    }
  };
  await walk(dir); return result;
};
const hookPayload = result => {
  const context = result.hookSpecificOutput?.additionalContext;
  assert.equal(typeof context, "string");
  assert.ok(context.length <= 2400);
  return JSON.parse(context.slice(context.indexOf("\n") + 1));
};
try {
  const reader = join(fixture, "reader"), vault = join(fixture, "vault"), project = join(fixture, "project"), codex = join(fixture, "codex");
  await mkdir(join(reader, "dist"), { recursive: true });
  await mkdir(project); await mkdir(codex);
  await copyFile(join(root, "dist/cli.mjs"), join(reader, "dist/cli.mjs"));
  const cli = join(reader, "dist/cli.mjs");
  const created = spawnSync(process.execPath, [cli, "vault", "init", "--destination", vault, "--confirm-new-vault"], { encoding: "utf8", timeout: 10000 });
  assert.equal(created.status, 0, created.stderr);
  await writeFile(join(reader, ".context-router-storage.json"), JSON.stringify({ root: join(vault, "90_系统") }));
  await writeFile(join(vault, "90_系统/config/projects.yaml"), JSON.stringify({ projects: [{ id: "demo-project", name: "Demo", root: project, truthFiles: ["README.md"] }] }));
  await writeFile(join(project, "README.md"), "# Demo current truth\nThis is an isolated distribution check.\n");
  await mkdir(join(vault, "20_项目"), { recursive: true });
  await writeFile(join(vault, "20_项目/facts.md"), "---\nlocal_id: demo-facts\ntype: project\nprojects: [demo-project]\n---\n# 项目当前事实\n\n## 当前状态\n仅用于独立分发检查。\n");
  const config = { schemaVersion: 1, readerRoot: reader, hook: { enabled: true, maxHits: 2, maxContextChars: 2400, timeoutMs: 4000 } };
  await writeFile(join(codex, "local-knowledge.json"), JSON.stringify(config));
  const env = { CODEX_HOME: codex };
  const skill = join(root, "skills/local-knowledge/scripts/knowledge.mjs");
  const drafts = join(fixture, "drafts.json"), reviewed = join(fixture, "reviewed.json");
  await writeFile(drafts, JSON.stringify(["zebrafalcon", "cobaltowl"].map(term => ({
    title: term + " method", kind: "research", projects: ["demo-project"], observedAt: "2026-10-15T00:00:00.000Z",
    sources: [{ ref: "https://example.com/" + term, readScope: "link_only" }],
    body: "# " + term + " method\n\n## 结论与用法\n" + term + " 仅用于独立分发检查。\n\n## 适用边界\n隔离样本，实际效果未知。\n",
  }))));
  const preview = run(skill, ["capture-preview", "--file", drafts], undefined, env);
  assert.equal(preview.changes.length, 2);
  await writeFile(reviewed, JSON.stringify(preview));
  run(skill, ["capture-save", "--preview", reviewed, "--expected-preview-hash", preview.previewHash, "--confirm"], undefined, env);
  const first = run(skill, ["search", "zebrafalcon", "--project", "demo-project"], undefined, env);
  assert.equal(first.length, 1);
  const note = run(skill, ["get", first[0].id], undefined, env);
  assert.ok(note.body.includes("zebrafalcon"));
  const before = await inventory(fixture);
  for (const term of ["zebrafalcon", "cobaltowl"]) {
    const result = run(skill, ["context", "研究 " + term, "--workspace", project], undefined, env);
    assert.equal(result.project.id, "demo-project");
    assert.equal(result.truthAvailable, true);
    assert.equal(result.hits.length, 1);
    assert.ok(result.hits[0].body?.includes(term) || result.hits[0].snippet?.includes(term));
  }
  const command = join(root, "src/interfaces/local-knowledge-hook-command.mjs");
  const startup = hookPayload(run(command, ["--event", "SessionStart"], JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "distribution-startup", cwd: project }), env));
  assert.equal(startup.retrievalScope, "project_bootstrap");
  assert.equal(startup.taskQueryAvailable, false);
  assert.deepEqual(startup.hits.map(hit => hit.id), ["demo-facts"]);
  for (const [term, expectedCount] of [["zebrafalcon", 1], ["zyxnonexistent", 0]]) {
    const task = hookPayload(run(command, ["--event", "UserPromptSubmit"], JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "distribution-task", cwd: project, prompt: "研究 " + term }), env));
    assert.equal(task.retrievalScope, "task_query"); assert.equal(task.taskQueryAvailable, true);
    assert.equal(task.projectTruthLoaded, false); assert.equal(task.hits.length, expectedCount);
    if (expectedCount) assert.ok(task.hits[0].snippet.includes(term));
  }
  assert.deepEqual(await inventory(fixture), before);
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  assert.equal(pkg.version, "1.1.0"); assert.equal(lock.version, pkg.version); assert.equal(lock.packages[""].version, pkg.version);
  assert.deepEqual(lock.packages[""].dependencies, pkg.dependencies);
  process.stdout.write(JSON.stringify({ version: pkg.version, isolated: true, captureReadback: true, skillTaskQueries: 2, startup: true, taskHitAndEmpty: true, readOnlyFileSetStable: true, lockfileMatches: true, hostAcceptanceRepeated: false }) + "\n");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
