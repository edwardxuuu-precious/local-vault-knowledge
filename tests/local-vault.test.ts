import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import matter from "gray-matter";
import { LocalVault } from "../src/application/local-vault.js";
import { digest, fileHash, stable, walk } from "../src/application/local-vault-files.js";
import { refreshLocalNavigation } from "../src/application/local-vault-navigation.js";
import { exportPrivatePackage, importPackage, inspectPackage, previewPublicPackage, exportPublicPackage, previewReturnedEdits,
  initializeLocalVault, bindImportedCopy } from "../src/application/local-vault-pack.js";
import { previewOrganization, applyOrganization } from "../src/application/local-vault-organization.js";
import { previewCaptureFiles, applyCapture, type CaptureDraft } from "../src/application/local-vault-capture.js";
import * as tar from "tar";
import { createLocalVaultMcpServer } from "../src/interfaces/vault-mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const dirs: string[] = [], databases: DatabaseSync[] = [];
afterEach(async () => { for (const db of databases.splice(0)) db.close(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "llmw-local-vault-test-")); dirs.push(dir);
  const vault = join(dir, "vault"), system = join(vault, "90_系统");
  for (const path of ["config", "runtime", "vault-notes", "knowledge/conflicts"]) await mkdir(join(system, path), { recursive: true });
  await writeFile(join(system, "config/storage.json"), JSON.stringify({ vaultPath: vault }));
  await writeFile(join(system, "config/projects.yaml"), "projects:\n  - id: alpha\n    name: Alpha\n    root: " + join(dir, "absent-project") + "\n  - id: beta\n    name: Beta\n    root: " + join(dir, "beta") + "\n");
  await writeFile(join(system, "config/knowledge-spaces.yaml"), "spaces:\n  - projectId: general\n    discovery: global_discovery\n");
  const db = new DatabaseSync(join(system, "runtime/knowledge.sqlite")); databases.push(db);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE documents(id TEXT,project_id TEXT,status TEXT,privacy_class TEXT,source_ref TEXT,updated_at TEXT); CREATE TABLE events(event_id TEXT,payload_json TEXT);");
  const records: Record<string, unknown> = {};
  async function note(id: string, path: string, body: string, project: string, privacy = "internal") {
    const metadata = { id, objectIds: [id], sourceRef: "knowledge/" + id + ".md", sourceStatus: "needs_evidence" };
    const raw = "---\n" + "context_router: " + JSON.stringify(metadata) + "\n---\n" + body;
    await mkdir(join(vault, path, ".."), { recursive: true }); await writeFile(join(vault, path), raw);
    records[digest(id)] = { metadata, relativePath: path, baselineBodyHash: digest(matter(raw).content),
      latestSourceBodyHash: digest(matter(raw).content), protectedFrontmatter: {} };
    db.prepare("INSERT INTO documents VALUES(?,?,?,?,?,?)").run(id, project, "needs_evidence", privacy, metadata.sourceRef, "2026-10-14");
    return raw;
  }
  const raw = await note("lock", "30_知识与经验/设备/锁屏.md", "# 无线导入先检查锁屏\n\n## 结论与用法\n设备 Locked 时停止启动。\n\n## 适用边界\n仅 Alpha 项目；原验收为一份会话。\n\n## 未结事项\n实际改善未知。\n", "alpha");
  await note("private", "30_知识与经验/设备/私密.md", "# 私密账号\nsecret material\n", "alpha", "restricted");
  await note("beta", "30_知识与经验/设备/别项目.md", "# 锁屏\nBeta only\n", "beta");
  await note("generic", "30_知识与经验/方法/证据.md", "# 证据\n\n## 适用边界\n通用研究，效果待验证。\n", "general");
  await note("audit", "90_审计资料/记录.md", "# 锁屏\n原过程不得扩大默认召回\n", "alpha");
  await writeFile(join(system, "vault-notes/manifest.json"), JSON.stringify({ version: 1, records }));
  await mkdir(join(system, "knowledge/conflicts/conflict-1"), { recursive: true });
  await writeFile(join(system, "knowledge/conflicts/conflict-1/case.yaml"), "id: conflict-1\nstatus: open\nprojectIds: [alpha]\nsummary: 待负责人确认边界\n");
  db.prepare("INSERT INTO events VALUES(?,?)").run("event-in-wal", '{"state":"committed"}');
  return { dir, vault, system, db, raw };
}
async function inventory(root: string) {
  return Promise.all((await walk(root)).map(async p => [p, await fileHash(join(root, p))]));
}
it("reads fresh Chinese context without modifying SQLite, WAL, manifests, notes or file sets", async () => {
  const f = await fixture(), before = await inventory(f.vault), v = await LocalVault.open(f.vault);
  expect(v.search("设备锁住以后是否继续导入", "alpha").some(n => n.id === "lock")).toBe(true);
  expect(v.search("锁屏", "alpha").map(n => n.id)).not.toContain("beta");
  expect(v.search("secret", "alpha")).toEqual([]);
  expect(v.search("锁屏", "alpha").map(n => n.id)).not.toContain("audit");
  expect(() => v.get("private")).toThrow(/Restricted/);
  const context = await v.buildContext("锁屏效果", undefined, "alpha");
  expect(context.truthAvailable).toBe(false);
  expect(context.conflicts[0]?.summary).toContain("确认");
  expect(context.hits[0]?.openItems).toContain("实际改善未知");
  expect((await v.buildContext("锁屏", "/unregistered")).hits.map(n => n.id)).not.toContain("lock");
  expect(v.previewChange("lock", digest(f.raw), f.raw).changed).toBe(false);
  expect(await inventory(f.vault)).toEqual(before);
});
it("reads the real structured truth-file contract, safe missing files and legacy string locators without writes", async () => {
  const f = await fixture(), project = join(f.dir, "project");
  await mkdir(project); await writeFile(join(project, "事实.md"), "当前边界：仅本项目。");
  await writeFile(join(project, "长文.md"), "甲".repeat(12001));
  await writeFile(join(f.system, "config/projects.yaml"), JSON.stringify({ projects: [
    { id: "alpha", name: "Alpha", root: project, truthFiles: [{ kind: "project_doc", path: "事实.md" }] },
    { id: "beta", name: "Beta", root: project, truthFiles: ["不存在.md", { kind: "project_doc", path: "长文.md" }] },
  ] }));
  const before = await inventory(f.vault), v = await LocalVault.open(f.vault);
  const context = await v.buildContext("锁屏", undefined, "alpha");
  expect(context.truthAvailable).toBe(true); expect(context.truthRefs[0]?.body).toContain("仅本项目");
  const missing = await v.buildContext("锁屏", undefined, "beta");
  expect(missing.truthAvailable).toBe(false); expect(missing.truthRefs[0]?.available).toBe(false);
  expect(missing.truthRefs[0]?.unavailableReason).toBe("文件不存在");
  expect(missing.truthRefs[1]?.unavailableReason).toContain("12000");
  expect(missing.warnings.some(w => w.includes("当前真源"))).toBe(true);
  expect(await inventory(f.vault)).toEqual(before);
});
it("returns useful content rather than empty heading chunks and prioritizes matching project evidence", async () => {
  const f = await fixture();
  for (const [id, projects, body] of [
    ["project-backup", ["alpha"], "# 重复备份\n\n## 结论与用法\n内容没有变化时不创建备份。\n\n## 适用边界\n仅 Alpha 项目。\n"],
    ["heading-only", ["general"], "# 重复备份\n\n## 结论与用法\n\n## 适用边界\n"],
    ["global-backup", ["general"], "# 重复备份\n\n## 结论与用法\n通用建议：需要恢复时才创建备份。\n\n## 适用边界\n需要自行验证。\n"],
  ] as const) await writeFile(join(f.vault, "30_知识与经验/方法/" + id + ".md"), "---\nlocal_id: " + id + "\nprojects: " + JSON.stringify(projects) + "\n---\n" + body);
  const results = (await LocalVault.open(f.vault)).search("重复备份", "alpha");
  expect(results[0]?.id).toBe("project-backup");
  expect(results.map(r => r.id)).not.toContain("heading-only");
  expect(results.every(r => Boolean(r.snippet.replace(/^#{1,3} .*$/gmu, "").trim()))).toBe(true);
});
const captureDraft = (): CaptureDraft => ({ title: "导入失败先检查设备状态", kind: "experience", projects: ["alpha"],
  observedAt: "2026-10-14T10:00:00.000Z", sources: [{ ref: "https://example.org/report", readScope: "link_only" }],
  body: "# 导入失败先检查设备状态\n\n## 结论与用法\n发现设备锁定时先停止当前导入。\n\n## 适用边界\n仅 Alpha 的导入流程；其他项目效果未知。\n\n## 未结事项\n实际改善未知。\n" });
it("previews meaningful capture without writes and saves only the confirmed scope; repetition produces no files", async () => {
  const f = await fixture(), v = await LocalVault.open(f.vault), before = await inventory(f.vault);
  const preview = await previewCaptureFiles(v, [captureDraft()]);
  expect(await inventory(f.vault)).toEqual(before);
  await expect(applyCapture(v, preview, preview.previewHash, false)).rejects.toThrow(/confirmation/);
  const canonical = await inventory(f.system);
  expect((await applyCapture(v, preview, preview.previewHash, true)).saved).toBe(1);
  const saved = await LocalVault.open(f.vault), note = saved.get(preview.changes[0]!.id);
  expect(note.status).toBe("unverified"); expect(note.sourceRefs).toContain("https://example.org/report");
  expect(note.sourceContentCoverage).toBe("link_only"); expect(note.asOf).toBe("2026-10-14T10:00:00.000Z");
  expect((await saved.buildContext("设备状态", undefined, "beta")).hits.map(n => n.id)).not.toContain(note.id);
  const first = await inventory(f.vault);
  expect((await applyCapture(saved, preview, preview.previewHash, true)).saved).toBe(0);
  expect(await inventory(f.vault)).toEqual(first); expect(await inventory(f.system)).toEqual(canonical);
  expect((await previewCaptureFiles(saved, [captureDraft()])).changes[0]?.action).toBe("reuse");
});
it("updates one body by reviewed base, preserves metadata and original bytes, and rejects changes after preview", async () => {
  const f = await fixture(), initial = await LocalVault.open(f.vault), draft = captureDraft();
  const p = await previewCaptureFiles(initial, [draft]); await applyCapture(initial, p, p.previewHash, true);
  let v = await LocalVault.open(f.vault), note = v.get(p.changes[0]!.id);
  const original = await readFile(join(f.vault, note.path), "utf8"), fields = note.protectedFields;
  const update = { ...draft, targetId: note.id, baseHash: note.rawHash, body: draft.body.replace("实际改善未知。", "本次导入成功；其他场景效果未知。") };
  const proposal = await previewCaptureFiles(v, [update]);
  await applyCapture(v, proposal, proposal.previewHash, true); v = await LocalVault.open(f.vault); note = v.get(note.id);
  expect(note.protectedFields).toEqual(fields); expect(note.status).toBe("unverified");
  const histories = (await walk(f.vault)).filter(p => p.startsWith("90_审计资料/正文原版本/"));
  expect(histories).toHaveLength(1); expect(await readFile(join(f.vault, histories[0]!), "utf8")).toBe(original);
  const next = await previewCaptureFiles(v, [{ ...update, baseHash: note.rawHash, body: update.body + "\n补充边界。\n" }]);
  await writeFile(join(f.vault, note.path), await readFile(join(f.vault, note.path), "utf8") + "\n独立编辑。\n");
  await expect(applyCapture(await LocalVault.open(f.vault), next, next.previewHash, true)).rejects.toThrow(/changed/);
});
it("prevents duplicate-topic bodies, scope expansion, credential storage and occupied capture paths", async () => {
  const f = await fixture(), v = await LocalVault.open(f.vault), draft = captureDraft();
  await expect(previewCaptureFiles(v, [{ ...draft, projects: ["*"] }])).rejects.toThrow(/origin scope/);
  await expect(previewCaptureFiles(v, [{ ...draft, path: "90_系统/knowledge/new.md" }])).rejects.toThrow(/destination/);
  await expect(previewCaptureFiles(v, [{ ...draft, sources: [{ ref: "https://example.org/?token=private-value", readScope: "full" }] }])).rejects.toThrow(/Credential/);
  const p = await previewCaptureFiles(v, [draft]); await applyCapture(v, p, p.previewHash, true);
  await expect(previewCaptureFiles(await LocalVault.open(f.vault), [{ ...draft, body: draft.body + "\n新的观察。\n" }])).rejects.toThrow(/same topic/);
});
it("adds independent evidence to the same body without losing prior sources or making another reading copy", async () => {
  const f = await fixture(), draft = captureDraft(), v = await LocalVault.open(f.vault);
  const initial = await previewCaptureFiles(v, [draft]); await applyCapture(v, initial, initial.previewHash, true);
  const nextDraft = { ...draft, sources: [{ ref: "https://example.org/second-result", readScope: "project_result" as const }] };
  const next = await previewCaptureFiles(await LocalVault.open(f.vault), [nextDraft]);
  expect(next.changes[0]?.action).toBe("update");
  await applyCapture(await LocalVault.open(f.vault), next, next.previewHash, true);
  const updated = await LocalVault.open(f.vault), note = updated.get(initial.changes[0]!.id);
  expect(note.sourceRefs).toContain(draft.sources[0]!.ref); expect(note.sourceRefs).toContain(nextDraft.sources[0]!.ref);
  expect(updated.notes.filter(n => !n.historical && n.id === note.id)).toHaveLength(1);
  expect((await previewCaptureFiles(updated, [nextDraft])).changes[0]?.action).toBe("reuse");
});
it("binds unregistered project experience to an anonymous origin fingerprint and keeps it out of other projects", async () => {
  const f = await fixture(), first = join(f.dir, "first-new-project"), second = join(f.dir, "second-new-project");
  await mkdir(first); await mkdir(second);
  const draft = { ...captureDraft(), projects: [], workspacePath: first };
  const preview = await previewCaptureFiles(await LocalVault.open(f.vault), [draft]);
  expect(preview.changes[0]?.projects[0]).toMatch(/^workspace:[a-f0-9]{24}$/);
  await applyCapture(await LocalVault.open(f.vault), preview, preview.previewHash, true);
  const v = await LocalVault.open(f.vault), id = preview.changes[0]!.id;
  expect((await v.buildContext("设备状态", first)).hits.map(n => n.id)).toContain(id);
  expect((await v.buildContext("设备状态", second)).hits.map(n => n.id)).not.toContain(id);
  expect((await v.buildContext("设备状态", first)).warnings.join(" ")).toContain("reversible_trial_only");
  expect((await v.buildContext("设备状态", first)).truthAvailable).toBe(false);
});
it("keeps manual edits unverified after rename and rejects forged metadata, stale bases and duplicate IDs", async () => {
  const f = await fixture();
  await rename(join(f.vault, "30_知识与经验/设备/锁屏.md"), join(f.vault, "30_知识与经验/设备/新标题.md"));
  const raw = f.raw.replace("实际改善未知", "实际改善仍未知，未验收");
  await writeFile(join(f.vault, "30_知识与经验/设备/新标题.md"), raw);
  const v = await LocalVault.open(f.vault);
  expect(v.get("lock").status).toBe("unverified");
  expect(v.get("lock").path).toContain("新标题");
  expect(() => v.previewChange("lock", digest(f.raw), raw)).toThrow(/Base version/);
  expect(() => v.previewChange("lock", digest(raw), raw.replace("needs_evidence", "active"))).toThrow(/Protected/);
  await writeFile(join(f.vault, "30_知识与经验/设备/重复.md"), raw);
  await expect(LocalVault.open(f.vault).then(v => v.get("lock"))).rejects.toThrow(/conflict|review/u);
});
it("refreshes navigation and reading scope without altering bodies or existing settings; repeats are a no-op", async () => {
  const f = await fixture(), v = await LocalVault.open(f.vault);
  await mkdir(join(f.vault, ".obsidian"));
  await writeFile(join(f.vault, ".obsidian/app.json"), JSON.stringify({ userIgnoreFilters: ["私人草稿/"], alwaysUpdateLinks: true }));
  expect((await refreshLocalNavigation(v)).changed).toBeGreaterThan(0);
  expect(JSON.parse(await readFile(join(f.vault, ".obsidian/app.json"), "utf8"))).toEqual({
    userIgnoreFilters: ["私人草稿/", "90_系统/", "90_审计资料/"], alwaysUpdateLinks: true,
  });
  const first = await inventory(f.vault);
  expect((await refreshLocalNavigation(await LocalVault.open(f.vault))).changed).toBe(0);
  expect(await inventory(f.vault)).toEqual(first);
  expect(await readFile(join(f.vault, "30_知识与经验/设备/锁屏.md"), "utf8")).toBe(f.raw);
});
it("exports a full consistent snapshot containing committed WAL events without changing the source", async () => {
  const f = await fixture(), before = await inventory(f.vault), path = join(f.dir, "full.tar.gz");
  const result = await exportPrivatePackage(await LocalVault.open(f.vault), "full", path);
  const manifest = await inspectPackage(path);
  expect(manifest.sqlite?.events).toBe(1);
  expect(manifest.sqlite?.sourceHashes["knowledge.sqlite-wal"]).toBeDefined();
  expect(manifest.files.map(f => f.path)).not.toContain("90_系统/runtime/knowledge.sqlite-wal");
  expect(await inventory(f.vault)).toEqual(before);
  await expect(importPackage(path, join(f.dir, "copy"), result.packageId)).rejects.toThrow(/human/);
  const bytes = await readFile(path);
  await writeFile(join(f.dir, "broken.tar.gz"), bytes.subarray(0, bytes.length - 35));
  await expect(inspectPackage(join(f.dir, "broken.tar.gz"))).rejects.toThrow();
});
it("imports mobile data idempotently and shows independent edits without overwriting either side", async () => {
  const f = await fixture(), path = join(f.dir, "mobile.tar.gz");
  await refreshLocalNavigation(await LocalVault.open(f.vault));
  const result = await exportPrivatePackage(await LocalVault.open(f.vault), "mobile", path, ["lock"]);
  const destination = join(f.dir, "mobile");
  expect((await importPackage(path, destination, result.packageId)).activated).toBe(false);
  expect(JSON.parse(await readFile(join(destination, ".obsidian/app.json"), "utf8"))).toEqual({
    userIgnoreFilters: ["90_系统/", "90_审计资料/"],
  });
  const before = await inventory(destination);
  expect((await importPackage(path, destination, result.packageId)).unchanged).toBe(true);
  expect(await inventory(destination)).toEqual(before);
  const noEdits = await previewReturnedEdits(await LocalVault.open(f.vault), destination);
  expect(noEdits.edits).toEqual([]);
  expect(noEdits.newFiles).toEqual([]);
  await writeFile(join(destination, "30_知识与经验/设备/锁屏.md"), f.raw + "\n手机补充。\n");
  await writeFile(join(f.vault, "30_知识与经验/设备/锁屏.md"), f.raw + "\n电脑补充。\n");
  const preview = await previewReturnedEdits(await LocalVault.open(f.vault), destination);
  expect(preview.edits[0]?.state).toBe("both_edited");
  expect(preview.applied).toBe(false);
  await expect(importPackage(path, destination, result.packageId)).rejects.toThrow(/edited/);
  expect((await LocalVault.open(destination)).role).toBe("working_copy");
});
it("public export requires explicit clean reviewed selection and includes no private store or paths", async () => {
  const f = await fixture(), v = await LocalVault.open(f.vault);
  const drafts = [{ id: "lock", rawHash: digest(f.raw), body: "# 导入前检查设备\n\n## 适用边界\n仅适用于已核对设备状态的导入；效果未知。\n", rights: "original" as const, sources: [] }];
  const preview = previewPublicPackage(v, drafts);
  expect(preview.ready).toBe(true);
  expect(previewPublicPackage(v, [{ ...drafts[0]!, rights: "unknown" }]).ready).toBe(false);
  expect(previewPublicPackage(v, [{ ...drafts[0]!, sources: ["https://example.org/?access_token=private-value"] }]).ready).toBe(false);
  expect(previewPublicPackage(v, [{ ...drafts[0]!, body: drafts[0]!.body + "/" + "Users/private/key" }]).ready).toBe(false);
  await expect(exportPublicPackage(v, drafts, preview.previewHash, "reviewer", false, join(f.dir, "public.tar.gz"))).rejects.toThrow(/confirmation/);
  const result = await exportPublicPackage(v, drafts, preview.previewHash, "reviewer", true, join(f.dir, "public.tar.gz"));
  const manifest = await inspectPackage(result.destination);
  expect(manifest.kind).toBe("public");
  expect(manifest.sourceVault).toBeNull();
  expect(manifest.notes).toEqual([]);
  expect(manifest.files).toHaveLength(1);
});
it("initializes only an explicitly new Vault and never substitutes for a missing configured store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "local-init-test-")); dirs.push(dir);
  const destination = join(dir, "new");
  await initializeLocalVault(destination);
  expect((await LocalVault.open(destination)).notes.some(n => n.id === "first-note")).toBe(true);
  await expect(initializeLocalVault(destination)).rejects.toThrow(/exist/);
  await writeFile(join(destination, "90_系统/config/storage.json"), JSON.stringify({ vaultPath: join(dir, "missing") }));
  await expect(LocalVault.open(destination)).rejects.toThrow();
});
it("organizes reviewed reading paths without altering protected fields or overwriting concurrent edits", async () => {
  const f = await fixture(), from = join(f.vault, "30_知识与经验/设备/锁屏.md"), to = join(f.vault, "40_知识正文/lock.md");
  await mkdir(dirnameForTest(to), { recursive: true }); await rename(from, to);
  const vault = await LocalVault.open(f.vault), preview = await previewOrganization(vault, { lock: "设备导入检查" });
  expect(preview.moves).toHaveLength(1);
  await writeFile(to, f.raw + "\n并发编辑\n");
  await expect(applyOrganization(vault, preview, preview.previewHash)).rejects.toThrow(/changed/);
  await writeFile(to, f.raw);
  await applyOrganization(await LocalVault.open(f.vault), preview, preview.previewHash);
  const note = (await LocalVault.open(f.vault)).get("lock");
  expect(note.title).toBe("设备导入检查");
  expect(note.protectedFields.context_router).toEqual(matter(f.raw).data.context_router);
});
function dirnameForTest(path: string) { return join(path, ".."); }
it("keeps full imports inert until the isolated human binding and preserves the event ledger", async () => {
  const f = await fixture(), archive = join(f.dir, "full.tar.gz"), target = join(f.dir, "new-device");
  const exported = await exportPrivatePackage(await LocalVault.open(f.vault), "full", archive);
  await importPackage(archive, target, exported.packageId, true);
  const imported = await LocalVault.open(target);
  expect(imported.role).toBe("working_copy");
  await expect(exportPrivatePackage(imported, "full", join(f.dir, "bad.tar.gz"))).rejects.toThrow(/Working copy/);
  const before = await fileHash(join(target, "90_系统/runtime/knowledge.sqlite"));
  const options = { expectedId: exported.packageId, actor: "human_cli" as const, reviewer: "fixture-human",
    confirmSourceFrozen: false, backupPath: join(f.dir, "backups"), codeRoot: f.dir };
  await expect(bindImportedCopy(archive, target, options)).rejects.toThrow(/declaration/);
  await bindImportedCopy(archive, target, { ...options, confirmSourceFrozen: true });
  expect((await LocalVault.open(target)).role).toBe("primary");
  expect(await fileHash(join(target, "90_系统/runtime/knowledge.sqlite"))).toBe(before);
});
it("rejects archive symlinks and does not follow them during inspection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "local-archive-link-test-")); dirs.push(dir);
  await writeFile(join(dir, "secret"), "not part of package"); await symlink(join(dir, "secret"), join(dir, "link"));
  await tar.c({ cwd: dir, file: join(dir, "bad.tar.gz"), gzip: true }, ["link"]);
  await expect(inspectPackage(join(dir, "bad.tar.gz"))).rejects.toThrow();
});
it("matches numeric formatting and keeps unrelated generic notes out of focused queries", async () => {
  const f = await fixture();
  await writeFile(join(f.vault, "30_知识与经验/门槛.md"), "---\nlocal_id: threshold\nprojects: [alpha]\n---\n# 采购门槛\n\n## 结论与用法\n恰好2,000支的采购入口存在未解决冲突。\n\n## 适用边界\n仅Alpha历史事实，不作为当前门槛。\n\n## 补充关键事实与证据边界\n" + "其他来源的说明。".repeat(300) + "\n");
  const v = await LocalVault.open(f.vault);
  const hit = v.search("恰好2000支的采购入口", "alpha")[0];
  expect(hit?.id).toBe("threshold");
  expect(hit?.boundaries).toContain("不作为当前门槛");
  expect(hit?.boundaries).not.toContain("其他来源");
  expect(hit).not.toHaveProperty("body");
});
it("detects changed canonical revisions and keeps the old reading state separate from new approval", async () => {
  const f = await fixture();
  f.db.prepare("UPDATE documents SET source_ref=?,status=? WHERE id=?").run("knowledge/new-revision.md", "active", "lock");
  const changed = (await LocalVault.open(f.vault)).get("lock");
  expect(changed.sourceChanged).toBe(true);
  expect(changed.originalStatus).toBe("needs_evidence");
  expect(changed.currentCanonicalStatus).toBe("active");
  expect(changed.status).toBe("unverified");
});
it("exposes exactly four nonmutating MCP tools without installing or starting a real service", async () => {
  const f = await fixture(), before = await inventory(f.vault), server = createLocalVaultMcpServer(f.vault);
  const [left, right] = InMemoryTransport.createLinkedPair(), client = new Client({ name: "fixture", version: "1" });
  await server.connect(left); await client.connect(right);
  try {
    expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(["vault_context", "vault_get", "vault_preview_change", "vault_search"]);
    const response = await client.callTool({ name: "vault_context", arguments: { task: "锁屏", project: "alpha" } });
    expect(response.isError).not.toBe(true);
    expect(await inventory(f.vault)).toEqual(before);
  } finally { await client.close(); await server.close(); }
});
