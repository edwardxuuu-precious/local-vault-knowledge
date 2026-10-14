import { backup, DatabaseSync } from "node:sqlite";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as tar from "tar";
import matter from "gray-matter";
import { LocalVault, excludedReading } from "./local-vault.js";
import { defaultReadingExclusions } from "./local-vault-navigation.js";
import { detachedSqlite, digest, fileHash, inside, regular, stable, walk } from "./local-vault-files.js";

export interface PackageFile { path: string; sha256: string; bytes: number; mode: number; mtime: string; originalBirthtime: string | null }
export interface PackageManifest {
  format: "local-vault-pack"; version: 1; kind: "full" | "mobile" | "public"; packageId: string;
  files: PackageFile[]; notes: Array<{ id: string; path: string; rawHash: string; bodyHash: string; protectedFields: Record<string, unknown>; originalBirthtime?: string | null }>;
  sourceVault: string | null; sqlite: { events: number; eventHash: string; sourceHashes: Record<string, string> } | null;
  publication: { previewHash: string; reviewer: string; license: string } | null;
}
function ledger(db: DatabaseSync) {
  const hash = createHash("sha256"); let events = 0;
  for (const row of db.prepare("SELECT * FROM events ORDER BY event_id").iterate()) { hash.update(stable(row) + "\n"); events++; }
  return { events, eventHash: hash.digest("hex") };
}
const payloadPath = (dir: string, path: string) => inside(dir, "payload/" + path);
const idFor = (m: Omit<PackageManifest, "packageId">) => digest(stable(m));
const within = (root: string, path: string) => { const rel = relative(root, resolve(path)); return !rel || (!rel.startsWith("..") && !isAbsolute(rel)); };
export async function exportPrivatePackage(vault: LocalVault, kind: "full" | "mobile", destination: string, ids?: string[]) {
  if (kind === "full" && (!vault.system || vault.role !== "primary")) throw new Error("Working copy cannot export an authoritative full package");
  if (within(vault.root, destination)) throw new Error("Packages must be outside the active Vault");
  const temp = await mkdtemp(join(tmpdir(), "llmw-vault-pack-"));
  try {
    const all = await walk(vault.root, p => /(^|\/)(\.DS_Store|\.reconcile.lock|\.metadata-repair.lock)$/u.test(p));
    const selectedNotes = ids ? ids.map(id => vault.get(id)) : vault.notes.filter(n => vault.visible(n));
    const chosen = new Set(kind === "full" ? all.filter(p => !/-wal$|-shm$|-journal$/u.test(p)) : selectedNotes.map(n => n.path));
    if (kind === "mobile") {
      for (const path of all) if (!excludedReading(path) && /(^|\/)(首页|索引|如何使用)\.md$/u.test(path)) chosen.add(path);
      // Attachments are included only when a selected body explicitly references them.
      for (const note of selectedNotes) {
        const refs = [...note.body.matchAll(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|!\[[^\]]*\]\(([^)]+)\)/gu)];
        for (const ref of refs) {
          const target = ref[1] ?? ref[2]!;
          if (/^https?:\/\//u.test(target)) continue;
          const matches = all.filter(p => p === target || p === join(dirname(note.path), target).split("\\").join("/") || p.endsWith("/" + target));
          if (matches.length !== 1 || excludedReading(matches[0]!)) throw new Error("Attachment is ambiguous or unavailable: " + target);
          await regular(vault.root, matches[0]!); chosen.add(matches[0]!);
        }
      }
    }
    const files: PackageFile[] = [], sourceHashes: Record<string, string> = {};
    let sqlite: PackageManifest["sqlite"] = null;
    for (const path of [...chosen].sort()) {
      const source = await regular(vault.root, path), before = await stat(source), target = payloadPath(temp, path);
      const sourceHash = await fileHash(source);
      await mkdir(dirname(target), { recursive: true });
      if (path === "90_系统/runtime/knowledge.sqlite") {
        for (const suffix of ["", "-wal", "-journal"]) {
          const p = source + suffix;
          if (await lstat(p).then(() => true, () => false)) sourceHashes["knowledge.sqlite" + suffix] = await fileHash(p);
        }
        sqlite = await detachedSqlite(source, async db => {
          const result = ledger(db);
          await backup(db, target);
          return { ...result, sourceHashes };
        });
        const check = new DatabaseSync(target, { readOnly: true });
        try {
          if (check.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" || stable(ledger(check)) !== stable({ events: sqlite.events, eventHash: sqlite.eventHash }))
            throw new Error("Database snapshot verification failed");
        } finally { check.close(); }
      } else await copyFile(source, target);
      if (await fileHash(source) !== sourceHash || (await stat(source)).mtimeMs !== before.mtimeMs)
        throw new Error("Vault changed during export: " + path);
      await utimes(target, before.atime, before.mtime);
      files.push({ path, sha256: await fileHash(target), bytes: (await stat(target)).size, mode: before.mode & 0o777,
        mtime: before.mtime.toISOString(), originalBirthtime: before.birthtimeMs ? before.birthtime.toISOString() : null });
    }
    // Prove the whole file set and all exported source bytes stayed stable across the snapshot.
    const after = await walk(vault.root, p => /(^|\/)(\.DS_Store|\.reconcile.lock|\.metadata-repair.lock)$/u.test(p));
    if (stable(all) !== stable(after)) throw new Error("Vault file set changed during export");
    for (const file of files) {
      const expected = file.path === "90_系统/runtime/knowledge.sqlite" ? sourceHashes["knowledge.sqlite"] : file.sha256;
      if (await fileHash(await regular(vault.root, file.path)) !== expected) throw new Error("Source changed before publication");
    }
    for (const [name, hash] of Object.entries(sourceHashes))
      if (await fileHash(join(vault.system!, "runtime", name)) !== hash) throw new Error("SQLite WAL changed before publication");
    const notes = selectedNotes.map(n => {
      const file = files.find(f => f.path === n.path);
      if (!file || file.sha256 !== n.rawHash) throw new Error("Reading note changed before package snapshot: " + n.path);
      return { id: n.id, path: n.path, rawHash: n.rawHash, bodyHash: n.bodyHash, protectedFields: n.protectedFields, originalBirthtime: file.originalBirthtime };
    });
    if (kind === "mobile") {
      const workspace = JSON.stringify({ version: 1, role: "working_copy", baseNotes: notes }, null, 2) + "\n";
      const path = ".vault-workspace.json", target = payloadPath(temp, path);
      await writeFile(target, workspace, { mode: 0o600 });
      files.push({ path, sha256: digest(workspace), bytes: Buffer.byteLength(workspace), mode: 0o600, mtime: "1970-01-01T00:00:00.000Z", originalBirthtime: null });
      const reading = JSON.stringify({ userIgnoreFilters: defaultReadingExclusions }, null, 2) + "\n";
      const settingsPath = ".obsidian/app.json";
      await mkdir(dirname(payloadPath(temp, settingsPath)), { recursive: true });
      await writeFile(payloadPath(temp, settingsPath), reading, { mode: 0o600 });
      files.push({ path: settingsPath, sha256: digest(reading), bytes: Buffer.byteLength(reading), mode: 0o600,
        mtime: "1970-01-01T00:00:00.000Z", originalBirthtime: null });
    }
    return await publishPackage(temp, { format: "local-vault-pack", version: 1, kind, files, notes, sourceVault: vault.root, sqlite, publication: null }, destination);
  } finally { await rm(temp, { recursive: true, force: true }); }
}
async function publishPackage(dir: string, base: Omit<PackageManifest, "packageId">, destination: string) {
  const manifest: PackageManifest = { ...base, packageId: idFor(base) };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  if (await lstat(destination).then(() => true, () => false)) {
    const current = await inspectPackage(destination);
    if (current.packageId !== manifest.packageId) throw new Error("Destination contains a different package; refusing overwrite");
    return { destination, packageId: current.packageId, sha256: await fileHash(destination), unchanged: true, files: current.files.length };
  }
  await mkdir(dirname(resolve(destination)), { recursive: true });
  const pending = join(dir, "package.tar.gz");
  await tar.c({ gzip: true, cwd: dir, file: pending, portable: true }, ["manifest.json", ...manifest.files.map(f => "payload/" + f.path)]);
  const verified = await inspectPackage(pending);
  if (verified.packageId !== manifest.packageId) throw new Error("Package readback mismatch");
  await copyFile(pending, destination, 1); // COPYFILE_EXCL, also handles cross-filesystem destinations.
  return { destination, packageId: manifest.packageId, sha256: await fileHash(destination), unchanged: false, files: manifest.files.length };
}
async function unpack<T>(path: string, read: (directory: string, manifest: PackageManifest) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "llmw-vault-unpack-"));
  try {
    const input = join(dir, ".input.tar.gz"), beforeHash = await fileHash(path);
    await copyFile(path, input);
    if (await fileHash(input) !== beforeHash || await fileHash(path) !== beforeHash) throw new Error("Archive changed during inspection");
    const names = new Set<string>(); let bytes = 0;
    await new Promise<void>((done, reject) => {
      const source = createReadStream(input);
      const parser = new tar.Parser({ strict: true, maxDecompressionRatio: 1000, onReadEntry: entry => {
        try {
          if (!["File", "Directory"].includes(entry.type) || entry.linkpath) throw new Error("Archive links or special files are forbidden");
          const name = entry.path.replace(/\/$/u, "");
          inside(dir, name);
          if (name !== "manifest.json" && name !== "payload" && !name.startsWith("payload/")) throw new Error("Unexpected archive member");
          if (names.has(name)) throw new Error("Duplicate archive member");
          names.add(name); bytes += entry.size;
          if (names.size > 100_002 || bytes > 4_000_000_000 || entry.size > 512_000_000) throw new Error("Package exceeds bounded limits");
          entry.resume();
        } catch (error) {
          source.destroy(); parser.abort(error instanceof Error ? error : new Error(String(error))); reject(error);
        }
      } });
      parser.on("error", error => { source.destroy(); reject(error); });
      parser.on("end", done);
      parser.on("drain", () => source.resume());
      source.on("data", chunk => { if (!parser.write(chunk)) source.pause(); });
      source.on("end", () => parser.end());
      source.on("error", error => { parser.abort(error); reject(error); });
    });
    await tar.x({ file: input, cwd: dir, strict: true, preservePaths: false, maxDecompressionRatio: 1000 });
    const raw = await readFile(join(dir, "manifest.json"), "utf8");
    if (Buffer.byteLength(raw) > 32_000_000) throw new Error("Manifest exceeds limit");
    const manifest = JSON.parse(raw) as PackageManifest;
    if (manifest.format !== "local-vault-pack" || manifest.version !== 1 || !["full", "mobile", "public"].includes(manifest.kind)
      || !Array.isArray(manifest.files) || !Array.isArray(manifest.notes) || manifest.files.length > 100_000) throw new Error("Unknown package format");
    const { packageId, ...base } = manifest;
    if (packageId !== idFor(base)) throw new Error("Manifest identity mismatch");
    const fileSet = new Set<string>();
    for (const f of manifest.files) {
      if (fileSet.has(f.path) || !/^[a-f0-9]{64}$/u.test(f.sha256) || !Number.isSafeInteger(f.bytes) || f.bytes < 0) throw new Error("Invalid package file");
      fileSet.add(f.path);
      const file = await regular(dir, "payload/" + f.path);
      if ((await stat(file)).size !== f.bytes || await fileHash(file) !== f.sha256) throw new Error("Package content mismatch: " + f.path);
    }
    const actual = (await walk(dir)).filter(p => p !== "manifest.json" && p !== ".input.tar.gz").map(p => p.replace(/^payload\//u, ""));
    if (stable(actual.slice().sort()) !== stable([...fileSet].sort())) throw new Error("Extra or missing package file");
    if (manifest.sqlite) {
      const db = new DatabaseSync(payloadPath(dir, "90_系统/runtime/knowledge.sqlite"), { readOnly: true });
      try {
        if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok"
          || stable(ledger(db)) !== stable({ events: manifest.sqlite.events, eventHash: manifest.sqlite.eventHash })) throw new Error("Ledger proof mismatch");
      } finally { db.close(); }
    }
    return await read(dir, manifest);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
export async function inspectPackage(path: string): Promise<PackageManifest> { return unpack(path, async (_, m) => m); }
export async function initializeLocalVault(destination: string) {
  if (await lstat(destination).then(() => true, () => false)) throw new Error("New Vault destination must not exist");
  const root = resolve(destination), system = join(root, "90_系统");
  await mkdir(dirname(root), { recursive: true });
  const staging = await mkdtemp(join(dirname(root), ".vault-init-"));
  try {
    for (const dir of ["config", "runtime", "vault-notes", "knowledge/conflicts"])
      await mkdir(join(staging, "90_系统", dir), { recursive: true });
    await writeFile(join(staging, "90_系统/config/storage.json"), JSON.stringify({ schemaVersion: 1, vaultPath: root }) + "\n");
    await writeFile(join(staging, "90_系统/config/projects.yaml"), "schemaVersion: 1\nprojects: []\n");
    await writeFile(join(staging, "90_系统/config/knowledge-spaces.yaml"), "schemaVersion: 1\nspaces: []\n");
    await writeFile(join(staging, "90_系统/config/vault-presentation.json"), '{"version":1,"mode":"local_first"}\n');
    await writeFile(join(staging, "90_系统/vault-notes/manifest.json"), '{"version":1,"records":{}}\n');
    const db = new DatabaseSync(join(staging, "90_系统/runtime/knowledge.sqlite"));
    try {
      db.exec("CREATE TABLE documents(id TEXT PRIMARY KEY,project_id TEXT,status TEXT,privacy_class TEXT,source_ref TEXT,updated_at TEXT);"
        + "CREATE TABLE events(event_id TEXT PRIMARY KEY,payload_json TEXT);"
        + "CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'events are append-only'); END;"
        + "CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'events are append-only'); END;");
    } finally { db.close(); }
    await mkdir(join(staging, "00_收件箱"), { recursive: true });
    await writeFile(join(staging, "00_收件箱/第一条笔记.md"), "---\nlocal_id: first-note\n---\n# 第一条笔记\n\n## 结论与用法\n在这里写需要保存的关键事实。\n\n## 适用边界\n待核对来源与适用范围。\n");
    await rename(staging, root);
  } finally { await rm(staging, { recursive: true, force: true }); }
  return { root, system, initialized: true, routerEnabled: false };
}
/** This stages a working copy only. It never replaces a Vault or edits host/plugin locators. */
export async function importPackage(path: string, destination: string, expectedId: string, humanConfirmed = false) {
  return unpack(path, async (dir, manifest) => {
    if (manifest.packageId !== expectedId) throw new Error("Reviewed package identity changed");
    if (manifest.kind === "full" && !humanConfirmed) throw new Error("Full package staging is human CLI only");
    if (await lstat(destination).then(() => true, () => false)) {
      const marker = JSON.parse(await readFile(join(destination, ".vault-import.json"), "utf8")) as { packageId: string };
      if (marker.packageId !== expectedId) throw new Error("Existing destination belongs to another package");
      for (const f of manifest.files) if (await fileHash(await regular(destination, f.path)) !== f.sha256)
        throw new Error("Existing working copy was edited; inspect changes instead of overwriting");
      return { destination, packageId: expectedId, unchanged: true, activated: false };
    }
    const staging = await mkdtemp(join(dirname(resolve(destination)), ".vault-stage-"));
    try {
      for (const f of manifest.files) {
        const target = inside(staging, f.path); await mkdir(dirname(target), { recursive: true });
        await copyFile(payloadPath(dir, f.path), target);
        await utimes(target, new Date(f.mtime), new Date(f.mtime));
      }
      await writeFile(join(staging, ".vault-import.json"), JSON.stringify({ version: 1, packageId: expectedId, kind: manifest.kind, role: "working_copy" }) + "\n");
      await rename(staging, destination);
    } finally { await rm(staging, { recursive: true, force: true }); }
    return { destination, packageId: expectedId, unchanged: false, activated: false };
  });
}
/** Human-only active-store binding. Offline source freezing is a declaration, not distributed-lock proof. */
export async function bindImportedCopy(packagePath: string, destination: string, options: {
  expectedId: string; actor: "human_cli"; reviewer: string; confirmSourceFrozen: boolean; backupPath: string; codeRoot: string;
}) {
  if (options.actor !== "human_cli" || !options.reviewer.trim() || !options.confirmSourceFrozen)
    throw new Error("Human reviewer and explicit frozen-source declaration are required");
  const root = resolve(destination);
  if (!isAbsolute(options.backupPath) || within(root, options.backupPath) || !isAbsolute(options.codeRoot))
    throw new Error("Absolute code root and outside-Vault backup path are required");
  const manifest = await inspectPackage(packagePath);
  if (manifest.kind !== "full" || manifest.packageId !== options.expectedId) throw new Error("Exact full package required for binding");
  const markerPath = join(root, ".vault-import.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8")) as { packageId: string; role: string };
  if (marker.packageId !== manifest.packageId) throw new Error("Working copy identity mismatch");
  const configPath = await regular(root, "90_系统/config/storage.json");
  const raw = await readFile(configPath, "utf8"), current = JSON.parse(raw) as Record<string, unknown>;
  if (marker.role === "primary") {
    if (current.vaultPath !== root || current.codeRoot !== options.codeRoot || current.backupPath !== options.backupPath)
      throw new Error("Already bound with different locations; review drift");
    return { root, activated: true, unchanged: true, routerEnabled: false, sourceFrozen: "human_declared" };
  }
  if (marker.role !== "working_copy") throw new Error("Invalid handoff role");
  for (const file of manifest.files) if (await fileHash(await regular(root, file.path)) !== file.sha256)
    throw new Error("Staged data changed; review before binding");
  const saved = join(root, "90_系统/迁移记录/手动换机配置", manifest.packageId + ".json");
  await mkdir(dirname(saved), { recursive: true }); await writeFile(saved, raw, { flag: "wx", mode: 0o600 }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EEXIST") throw e;
  });
  const mappings = Array.isArray(current.pathMappings) ? current.pathMappings : [];
  const next = { ...current, vaultPath: root, backupPath: options.backupPath, codeRoot: options.codeRoot,
    pathMappings: [...mappings, ...(manifest.sourceVault ? [{ from: manifest.sourceVault, to: root }] : [])] };
  try {
    await writeFile(configPath, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    await writeFile(markerPath, JSON.stringify({ ...marker, role: "primary", reviewer: options.reviewer, sourceFrozen: "human_declared" }) + "\n", { mode: 0o600 });
  } catch (error) { await writeFile(configPath, raw); throw error; }
  return { root, activated: true, unchanged: false, routerEnabled: false, sourceFrozen: "human_declared" };
}
export async function previewReturnedEdits(vault: LocalVault, workingCopy: string) {
  const workspace = JSON.parse(await readFile(join(workingCopy, ".vault-workspace.json"), "utf8")) as { role: string; baseNotes: PackageManifest["notes"] };
  if (workspace.role !== "working_copy") throw new Error("Not a mobile working copy");
  const output = [];
  const paths = await walk(workingCopy, p => excludedReading(p));
  for (const base of workspace.baseNotes) {
    const current = vault.get(base.id);
    let path = base.path;
    if (!paths.includes(path)) {
      const matches = [];
      for (const p of paths.filter(p => p.endsWith(".md"))) {
        const raw = await readFile(await regular(workingCopy, p), "utf8"), data = matter(raw).data;
        if (data.context_router?.id === base.id || data.local_id === base.id) matches.push(p);
      }
      if (matches.length !== 1) { output.push({ id: base.id, state: "missing_or_duplicate", applied: false }); continue; }
      path = matches[0]!;
    }
    const raw = await readFile(await regular(workingCopy, path), "utf8"), mobileHash = digest(raw);
    if (mobileHash === base.rawHash) continue;
    let preview: unknown;
    try { preview = vault.previewChange(base.id, current.rawHash, raw); }
    catch (error) { preview = { blocked: String(error) }; }
    output.push({ id: base.id, state: current.rawHash === base.rawHash ? "mobile_only" : "both_edited",
      baseHash: base.rawHash, currentHash: current.rawHash, mobileHash, path, preview, applied: false });
  }
  const known = new Set(workspace.baseNotes.map(n => n.path));
  return { edits: output, newFiles: paths.filter(p => p.startsWith("00_收件箱/") && p.endsWith(".md")
    && !/(^|\/)(索引|首页)\.md$/u.test(p) && !known.has(p)), applied: false };
}
export interface PublicDraft { id: string; rawHash: string; body: string; rights: "original" | "permission" | "unknown"; sources: string[] }
export function previewPublicPackage(vault: LocalVault, drafts: PublicDraft[]) {
  if (!drafts.length || new Set(drafts.map(d => d.id)).size !== drafts.length) throw new Error("Explicit unique selection is required");
  const items = drafts.map(d => {
    const note = vault.get(d.id), flags = [];
    if (note.rawHash !== d.rawHash) flags.push("source_changed");
    if (!["original", "permission"].includes(d.rights)) flags.push("rights_unknown");
    if (note.privacy === "restricted") flags.push("restricted");
    if (/\/Users\/|[A-Z]:\\|90_系统|90_审计资料|context_router|Bearer\s|(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}|(?:password|api[_-]?key|secret)\s*[:=]/iu.test(d.body))
      flags.push("private_or_secret_material");
    if (d.sources.some(s => {
      try {
        const url = new URL(s);
        return !["http:", "https:"].includes(url.protocol) || Boolean(url.username || url.password)
          || /(?:token|api[_-]?key|password|signature|secret)=/iu.test(url.search) || /\/Users\/|90_系统|90_审计资料/u.test(decodeURIComponent(url.pathname));
      } catch { return true; }
    })) flags.push("nonpublic_source");
    if (d.body.startsWith("---")) flags.push("frontmatter_not_allowed");
    if (!d.body.trim()) flags.push("empty_public_body");
    if (!/适用|边界|限制/u.test(d.body)) flags.push("applicability_missing");
    return { ...d, title: d.body.match(/^# (.+)$/mu)?.[1] ?? note.title, originalStatus: note.originalStatus,
      evidenceState: note.status, scope: note.projects, flags };
  });
  return { format: "local-vault-public-preview", version: 1, previewHash: digest(stable(items)), items,
    ready: items.every(i => !i.flags.length), confirmationRequired: true, exported: false };
}
export async function exportPublicPackage(vault: LocalVault, drafts: PublicDraft[], expectedHash: string, reviewer: string, confirmed: boolean, destination: string) {
  if (within(vault.root, destination)) throw new Error("Public packages must be outside the active Vault");
  const preview = previewPublicPackage(vault, drafts);
  if (!confirmed || !reviewer.trim() || preview.previewHash !== expectedHash || !preview.ready) throw new Error("Exact clean public preview and human confirmation required");
  const dir = await mkdtemp(join(tmpdir(), "llmw-public-pack-"));
  try {
    const files: PackageFile[] = [];
    for (const item of preview.items) {
      const content = item.body.trim() + "\n\n- 证据状态：" + item.evidenceState + "；原状态：" + item.originalStatus
        + "\n- 授权：CC BY 4.0\n" + item.sources.map(s => "- 来源：" + s).join("\n") + "\n";
      const path = "知识/" + digest(content).slice(0, 16) + ".md", target = payloadPath(dir, path);
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, content, { mode: 0o600 });
      files.push({ path, sha256: digest(content), bytes: Buffer.byteLength(content), mode: 0o600, mtime: "1970-01-01T00:00:00.000Z", originalBirthtime: null });
    }
    return await publishPackage(dir, { format: "local-vault-pack", version: 1, kind: "public", files, notes: [], sourceVault: null,
      sqlite: null, publication: { previewHash: expectedHash, reviewer, license: "CC BY 4.0" } }, destination);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
