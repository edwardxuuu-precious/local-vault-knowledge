import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import matter from "gray-matter";
import { digest, fileHash, walk } from "../src/application/local-vault-files.js";
import { LocalVault } from "../src/application/local-vault.js";
import { readMemoryDocuments } from "../src/application/local-vault-memory.js";
import { runLocalKnowledgeHook, shouldLookupKnowledge } from "../src/application/local-knowledge-hook.js";

const owned: string[] = [], databases: DatabaseSync[] = [];
afterEach(async () => { for (const db of databases.splice(0)) db.close(); await Promise.all(owned.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "local-knowledge-hook-test-")); owned.push(dir);
  const vault = join(dir, "vault"), system = join(vault, "90_系统"), project = join(dir, "alpha"), other = join(dir, "beta");
  for (const p of [project, other, join(system, "config"), join(system, "runtime"), join(system, "vault-notes"), join(system, "knowledge/conflicts"), join(vault, "30_知识与经验")]) await mkdir(p, { recursive: true });
  await writeFile(join(system, "config/storage.json"), JSON.stringify({ vaultPath: vault }));
  await writeFile(join(system, "config/projects.yaml"), JSON.stringify({ projects: [{ id: "alpha", name: "Alpha", root: project, truthFiles: [{ path: "事实.md", kind: "project_doc" }] }, { id: "beta", name: "Beta", root: other }] }));
  await writeFile(join(system, "config/knowledge-spaces.yaml"), "spaces: []\n");
  const dbPath = join(system, "runtime/knowledge.sqlite"), db = new DatabaseSync(dbPath); databases.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE documents(id TEXT,project_id TEXT,status TEXT,privacy_class TEXT,source_ref TEXT,updated_at TEXT);");
  const records: Record<string, unknown> = {};
  for (const [id, scope, privacy] of [["lock-alpha", "alpha", "internal"], ["lock-beta", "beta", "internal"], ["private", "alpha", "restricted"]]) {
    const metadata = { id, objectIds: [id], sourceRef: "knowledge/" + id + ".md", sourceStatus: "needs_evidence" };
    const body = "# 设备锁屏导入经验\n\n## 结论与用法\n设备锁屏时停止导入，先核对状态。\n\n## 适用边界\n仅 " + scope + " 项目。\n\n## 未结事项\n实际改善未知。\n";
    const raw = "---\ncontext_router: " + JSON.stringify(metadata) + "\n---\n" + body;
    await writeFile(join(vault, "30_知识与经验/" + id + ".md"), raw);
    records[digest(id!)] = { metadata, baselineBodyHash: digest(matter(raw).content), latestSourceBodyHash: digest(matter(raw).content), protectedFrontmatter: {} };
    db.prepare("INSERT INTO documents VALUES(?,?,?,?,?,?)").run(id!, scope!, "needs_evidence", privacy!, metadata.sourceRef, "2026-10-14");
  }
  await writeFile(join(system, "vault-notes/manifest.json"), JSON.stringify({ records }));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  // This committed status exists only in WAL; the Hook must respect it.
  db.prepare("UPDATE documents SET status=?,updated_at=? WHERE id=?").run("active", "2026-10-14T09:00:00Z", "lock-alpha");
  return { dir, vault, system, project, other, db, dbPath };
}
const input = (cwd: string, prompt = "排查设备锁屏导致导入失败，参考已有经验") => ({ hook_event_name: "UserPromptSubmit", session_id: "isolated-session", turn_id: "isolated-turn", cwd, prompt });
async function inventory(root: string) { return Promise.all((await walk(root)).map(async p => [p, await fileHash(join(root, p))])); }
function context(result: Record<string, unknown>) {
  const text = (result.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;
  return text ? JSON.parse(text.slice(text.indexOf("\n") + 1)) as { hits: Array<{ id: string; canonicalStatus: string; openItems: string }>; project: string; conflicts: unknown[]; warnings: string[] } : null;
}
it("skips self-contained prompts and other events before opening any Vault", async () => {
  const load = vi.fn(async () => { throw new Error("must not open"); });
  for (const prompt of ["现在几点", "翻译这段项目文档", "好的", "2+3等于多少"]) {
    expect(shouldLookupKnowledge(prompt)).toBe(false);
    expect(await runLocalKnowledgeHook(input("/unavailable", prompt), "/missing", {}, load)).toEqual({});
  }
  expect(await runLocalKnowledgeHook({ hook_event_name: "Stop" }, "/missing", {}, load)).toEqual({}); expect(load).not.toHaveBeenCalled();
});
it("loads committed WAL identity and state entirely in memory without any file changes", async () => {
  const f = await fixture(), expected = f.db.prepare("SELECT id, project_id, status, privacy_class, source_ref, updated_at FROM documents").all().map(row => ({ ...row })), before = await inventory(f.dir);
  const rows = await readMemoryDocuments(f.dbPath);
  expect(rows.find(r => r.id === "lock-alpha")?.status).toBe("active");
  expect(rows).toEqual(expected);
  expect(await inventory(f.dir)).toEqual(before);
});
it("uses project scope, retains unknown effects and emits at most the configured necessary content", async () => {
  const f = await fixture(), result = await runLocalKnowledgeHook(input(f.project), f.vault);
  const data = context(result)!; expect(data.project).toBe("alpha");
  expect(data).toMatchObject({ trigger: "UserPromptSubmit", retrievalScope: "task_query", taskQueryAvailable: true, projectTruthLoaded: false });
  expect(data.hits.map(h => h.id)).toEqual(["lock-alpha"]);
  expect(data.hits[0]?.canonicalStatus).toBe("active"); expect(data.hits[0]?.openItems).toContain("实际改善未知");
  expect((result.hookSpecificOutput as { additionalContext: string }).additionalContext.length).toBeLessThanOrEqual(2400);
  expect(JSON.stringify(result)).not.toContain("lock-beta"); expect(JSON.stringify(result)).not.toContain('"id":"private"');
});
it("searches the actual task once and changes results when the question changes within the same project", async () => {
  const f = await fixture();
  await writeFile(join(f.vault, "30_知识与经验/zebrafalcon.md"), '---\nlocal_id: zebrafalcon\ntype: research\nprojects: [alpha]\n---\n# Zebrafalcon\n\n## 结论与用法\nZebrafalcon 样本只用于隔离检索验收。\n');
  const before = await inventory(f.dir), vault = await LocalVault.open(f.vault, { canonicalReadMode: "memory", currentReadingOnly: true });
  const search = vi.spyOn(vault, "search"), load = async () => vault;
  const first = context(await runLocalKnowledgeHook(input(f.project, "排查设备锁屏"), f.vault, {}, load));
  const second = context(await runLocalKnowledgeHook(input(f.project, "研究 zebrafalcon"), f.vault, {}, load));
  expect(search).toHaveBeenCalledTimes(2);
  expect(search).toHaveBeenNthCalledWith(1, "排查设备锁屏", "alpha", 5);
  expect(search).toHaveBeenNthCalledWith(2, "研究 zebrafalcon", "alpha", 5);
  expect(first?.hits.map(h => h.id)).toEqual(["lock-alpha"]);
  expect(second?.hits.map(h => h.id)).toEqual(["zebrafalcon"]);
  for (const data of [first, second]) expect(data).toMatchObject({ trigger: "UserPromptSubmit", retrievalScope: "task_query", taskQueryAvailable: true });
  expect(await inventory(f.dir)).toEqual(before);
});
it("reports a completed task query with no hits so it can be reused without a duplicate lookup", async () => {
  const f = await fixture(), before = await inventory(f.dir);
  const vault = await LocalVault.open(f.vault, { canonicalReadMode: "memory", currentReadingOnly: true }), search = vi.spyOn(vault, "search");
  const result = await runLocalKnowledgeHook(input(f.project, "研究 zyxnonexistent"), f.vault, {}, async () => vault);
  expect(search).toHaveBeenCalledExactlyOnceWith("研究 zyxnonexistent", "alpha", 5);
  expect(context(result)).toMatchObject({ trigger: "UserPromptSubmit", retrievalScope: "task_query", taskQueryAvailable: true, hits: [], warnings: [] });
  expect(await inventory(f.dir)).toEqual(before);
});
it("bootstraps a startup event from project facts without a user prompt or file changes", async () => {
  const f = await fixture(); await mkdir(join(f.vault, "20_项目"));
  for (const [id, scope, privacy] of [["alpha-facts", "alpha", "internal"], ["beta-facts", "beta", "internal"], ["global-facts", "*", "internal"], ["hidden-facts", "alpha", "restricted"]])
    await writeFile(join(f.vault, "20_项目/" + id + ".md"), `---\nlocal_id: ${id}\ntype: project\nprojects: ["${scope}"]\nprivacy: ${privacy}\n---\n# 当前事实\n\n## 当前状态\n本机入口已核验，长期效果未知。\n\n## 未结事项\n首条任务文本检索未覆盖。\n`);
  await writeFile(join(f.vault, "20_项目/alpha-guide.md"), '---\nlocal_id: alpha-guide\ntype: project\nprojects: [alpha]\n---\n# 项目说明\n\n## 当前状态\n另一份项目说明。\n');
  const before = await inventory(f.dir), vault = await LocalVault.open(f.vault, { canonicalReadMode: "memory", currentReadingOnly: true });
  const search = vi.spyOn(vault, "search"), startup = { hook_event_name: "SessionStart", source: "startup", session_id: "tool-created-session", cwd: f.project };
  const result = await runLocalKnowledgeHook(startup, f.vault, {}, async () => vault);
  const data = context(result)! as ReturnType<typeof context> & { trigger: string; retrievalScope: string; taskQueryAvailable: boolean };
  expect(result.hookSpecificOutput).toMatchObject({ hookEventName: "SessionStart" });
  expect(data).toMatchObject({ project: "alpha", trigger: "SessionStart", retrievalScope: "project_bootstrap", taskQueryAvailable: false });
  expect(data!.hits.map(h => h.id)).toEqual(["alpha-facts"]);
  expect(data!.hits[0]?.openItems).toContain("未覆盖");
  expect(await runLocalKnowledgeHook({ ...startup, prompt: "排查设备锁屏" }, f.vault, {}, async () => vault)).toEqual(result);
  expect(search).not.toHaveBeenCalled();
  expect((result.hookSpecificOutput as { additionalContext: string }).additionalContext.length).toBeLessThanOrEqual(2400);
  expect(await inventory(f.dir)).toEqual(before);
});
it("does not bootstrap resumed or forked histories, unknown workspaces, or projects without safe project notes", async () => {
  const load = vi.fn(async () => { throw new Error("must not open"); });
  for (const source of ["resume", "fork", "compact", "clear"])
    expect(await runLocalKnowledgeHook({ hook_event_name: "SessionStart", source }, "/missing", {}, load)).toEqual({});
  expect(load).not.toHaveBeenCalled();
  const f = await fixture(), unknown = join(f.dir, "unknown"); await mkdir(unknown);
  for (const cwd of [f.project, unknown])
    expect(await runLocalKnowledgeHook({ hook_event_name: "SessionStart", source: "startup", session_id: "startup-session", cwd }, f.vault)).toEqual({});
});
it("repeated Hook calls leave knowledge, ledger, manifest and file sets exactly stable", async () => {
  const f = await fixture(), before = await inventory(f.dir), outputs: unknown[] = [];
  for (let i = 0; i < 20; i++) outputs.push(await runLocalKnowledgeHook(input(f.project), f.vault));
  expect(outputs.every(o => JSON.stringify(o) === JSON.stringify(outputs[0]))).toBe(true);
  expect(await inventory(f.dir)).toEqual(before);
});
it("honors a new restricted or rejected state committed in WAL before delivery", async () => {
  const f = await fixture();
  f.db.prepare("UPDATE documents SET privacy_class=? WHERE id=?").run("restricted", "lock-alpha");
  expect(JSON.stringify(await runLocalKnowledgeHook(input(f.project), f.vault))).not.toContain("lock-alpha");
  f.db.prepare("UPDATE documents SET privacy_class=?,status=? WHERE id=?").run("internal", "rejected", "lock-alpha");
  expect(JSON.stringify(await runLocalKnowledgeHook(input(f.project), f.vault))).not.toContain("lock-alpha");
});
it("does not expand governed project scope from an edited reading tag", async () => {
  const f = await fixture(), path = join(f.vault, "30_知识与经验/lock-alpha.md");
  await writeFile(path, (await readFile(path, "utf8")).replace("---\n#", 'projects: ["*"]\n---\n#'));
  const result = await runLocalKnowledgeHook(input(f.other), f.vault);
  expect(JSON.stringify(result)).not.toContain("lock-alpha"); expect(context(result)?.hits.some(h => h.id === "lock-beta")).toBe(true);
});
it("preserves original project scope when a governed note is moved into personal reading", async () => {
  const f = await fixture(); await mkdir(join(f.vault, "10_个人"));
  await rename(join(f.vault, "30_知识与经验/lock-alpha.md"), join(f.vault, "10_个人/lock-alpha.md"));
  const result = await runLocalKnowledgeHook(input(f.other), f.vault);
  expect(JSON.stringify(result)).not.toContain("lock-alpha"); expect(context(result)?.hits.some(h => h.id === "lock-beta")).toBe(true);
});
it("fails softly on missing configuration, invalid inputs and corrupt WAL without initializing another store", async () => {
  const f = await fixture(), before = await readdir(f.dir);
  for (const raw of [{ ...input(f.project), cwd: "relative" }, { ...input(f.project), session_id: "" }])
    expect(JSON.stringify(await runLocalKnowledgeHook(raw, f.vault))).toContain("未完成自动查询");
  expect(JSON.stringify(await runLocalKnowledgeHook(input(f.project), join(f.dir, "missing")))).toContain("未完成自动查询");
  expect(await readdir(f.dir)).toEqual(before);
  const wal = await readFile(f.dbPath + "-wal"); wal[48] = (wal[48] ?? 0) ^ 1; await writeFile(f.dbPath + "-wal", wal);
  const corruptBefore = await inventory(f.dir);
  await expect(readMemoryDocuments(f.dbPath)).rejects.toThrow(/checksum/);
  expect(JSON.stringify(await runLocalKnowledgeHook(input(f.project), f.vault))).toContain("未完成自动查询");
  expect(await inventory(f.dir)).toEqual(corruptBefore);
});
it("keeps relevant conflicts and independent edits explicit without writing resolution or closeout", async () => {
  const f = await fixture(); await mkdir(join(f.system, "knowledge/conflicts/case"));
  await writeFile(join(f.system, "knowledge/conflicts/case/case.yaml"), "id: boundary-conflict\nstatus: open\nprojectIds: [alpha]\nsummary: 适用边界需用户决定\n");
  const result = await runLocalKnowledgeHook(input(f.project), f.vault); expect(context(result)?.conflicts).toHaveLength(1);
  expect(JSON.stringify(result)).toContain("需用户决定"); expect(result.decision).toBeUndefined(); expect(result.continue).not.toBe(false);
  expect((await LocalVault.open(f.vault)).get("lock-alpha").status).toBe("unverified");
});
it("never echoes credentials from prompts or reading bodies into developer context", async () => {
  const f = await fixture(), sensitive = "ghp_" + "x".repeat(40);
  expect(await runLocalKnowledgeHook(input(f.project, "排查 " + sensitive), f.vault)).toEqual({});
  const path = join(f.vault, "30_知识与经验/lock-alpha.md"); await writeFile(path, await readFile(path, "utf8") + "\n" + sensitive);
  const result = await runLocalKnowledgeHook(input(f.project), f.vault); expect(JSON.stringify(result)).not.toContain(sensitive);
  expect(JSON.stringify(result)).not.toContain("lock-alpha");
});
it("excludes audit data entirely on the automatic read path", async () => {
  const f = await fixture(); await mkdir(join(f.vault, "90_审计资料")); await writeFile(join(f.vault, "90_审计资料/broken.md"), "---\nmalformed audit source");
  expect(context(await runLocalKnowledgeHook(input(f.project), f.vault))?.hits[0]?.id).toBe("lock-alpha");
});
it("never represents an imported working copy as the current active library", async () => {
  const f = await fixture(); await writeFile(join(f.vault, ".vault-import.json"), JSON.stringify({ role: "working_copy" }));
  const before = await inventory(f.dir), result = await runLocalKnowledgeHook(input(f.project), f.vault);
  expect(JSON.stringify(result)).toContain("未完成自动查询"); expect(JSON.stringify(result)).not.toContain("lock-alpha");
  expect(await inventory(f.dir)).toEqual(before);
});
it("rejects unsupported database formats instead of treating a repaired header as current evidence", async () => {
  const f = await fixture(), main = await readFile(f.dbPath); main[19] = 99; await writeFile(f.dbPath, main);
  const before = await inventory(f.dir);
  await expect(readMemoryDocuments(f.dbPath)).rejects.toThrow(/Unsupported/);
  expect(JSON.stringify(await runLocalKnowledgeHook(input(f.project), f.vault))).toContain("未完成自动查询");
  expect(await inventory(f.dir)).toEqual(before);
});
