import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import matter from "gray-matter";
import YAML from "yaml";
import { LocalVault, type LocalNote } from "./local-vault.js";
import { digest, inside, regular, stable, workspaceFingerprint } from "./local-vault-files.js";

export interface CaptureSource {
  ref: string; readScope: "link_only" | "excerpt" | "full" | "project_result";
  version?: string; contentHash?: string;
}
export interface CaptureDraft {
  title: string; kind: "research" | "experience"; projects: string[];
  body: string; observedAt: string; sources: CaptureSource[];
  path?: string; targetId?: string; baseHash?: string;
  workspacePath?: string;
}
export interface CaptureChange {
  id: string; title: string; action: "create" | "update" | "reuse";
  path: string; baseHash: string | null; proposedRaw: string; rawHash: string;
  currentBody: string | null; proposedBody: string; projects: string[];
  sources: CaptureSource[]; possibleDuplicates: Array<{ id: string; title: string; path: string }>;
  workspacePath?: string;
}
export interface CapturePreview {
  format: "local-vault-capture-preview"; version: 1; vaultFingerprint: string;
  changes: CaptureChange[]; previewHash: string; resultingStatus: "unverified";
}
const createFields = new Set(["local_id", "type", "privacy", "status", "projects", "created_at", "observed_at", "sources", "source_content_coverage", "reuse_policy"]);
function scopeValid(vault: LocalVault, projects: string[], kind: string) {
  if (!Array.isArray(projects) || !projects.length || projects.length > 5
    || projects.some(p => p !== "*" && !/^workspace:[a-f0-9]{24}$/u.test(p) && !vault.projects.some(project => project.id === p))) throw new Error("Explicit known project scope is required");
  if (kind === "experience" && projects.some(p => p === "*" || vault.globalProjects.includes(p)))
    throw new Error("Observed project experience keeps its origin scope; global activation is human-reviewed");
}
const dateValid = (value: string) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}/u.test(value) && !Number.isNaN(Date.parse(value));
const privateMaterial = /(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{20,}|Bearer\s+\S+|(?:password|api[_-]?key|secret)\s*[:=]\s*["']?[A-Za-z0-9_-]{12,}/iu;
function notePath(path: string): void {
  if (!/^30_知识与经验\/.+\.md$/u.test(path) || path.split("/").some(p => !p || p.startsWith(".") || /[:\\]/u.test(p))
    || /(^|\/)(索引|首页|如何使用)\.md$/u.test(path)) throw new Error("Capture destination must be a current knowledge body");
}
function bodyValid(title: string, body: string): void {
  if (!title.trim() || title.length > 100 || /[\r\n/\\]/u.test(title) || typeof body !== "string"
    || !body.startsWith("# " + title + "\n") || !/^## 适用边界$/mu.test(body)
    || !/^## 结论与用法$/mu.test(body) || body.length > 20_000 || privateMaterial.test(body))
    throw new Error("A bounded body, understandable title, use, applicability and no credentials are required");
}
function sourcesValid(sources: CaptureSource[]): void {
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 10) throw new Error("Explicit bounded evidence locators are required");
  for (const source of sources) {
    if (!source || typeof source.ref !== "string" || !source.ref.trim()
      || !["link_only", "excerpt", "full", "project_result"].includes(source.readScope) || privateMaterial.test(source.ref))
      throw new Error("Source locator and actual reading scope are required");
    if (source.contentHash !== undefined && !/^[a-f0-9]{64}$/u.test(source.contentHash)) throw new Error("Invalid source version hash");
    if (/^https?:\/\//u.test(source.ref)) {
      const url = new URL(source.ref);
      if (url.username || url.password || /(?:token|password|api[_-]?key|signature|secret)=/iu.test(url.search))
        throw new Error("Credential-bearing source URL");
    } else if (/^[a-z][a-z0-9+.-]*:/iu.test(source.ref) && !isAbsolute(source.ref)) throw new Error("Unsupported source locator");
  }
}
function coverage(sources: CaptureSource[]): LocalNote["sourceContentCoverage"] {
  if (sources.some(s => s.readScope === "link_only")) return "link_only";
  if (sources.some(s => s.readScope === "excerpt")) return "excerpt";
  return sources.every(s => s.readScope === "project_result") ? "project_result" : "full";
}
const fingerprint = (vault: LocalVault) => digest(vault.root);
const proof = (preview: Omit<CapturePreview, "previewHash">) => digest(stable(preview));
export function previewCapture(vault: LocalVault, drafts: CaptureDraft[]): CapturePreview {
  if (!Array.isArray(drafts) || !drafts.length || drafts.length > 5) throw new Error("Review one bounded batch of up to five meaningful changes");
  const now = new Date().toISOString();
  const changes = drafts.map(draft => {
    bodyValid(draft.title, draft.body); sourcesValid(draft.sources);
    if (!["research", "experience"].includes(draft.kind) || !dateValid(draft.observedAt)) throw new Error("Knowledge kind and observation date are required");
    scopeValid(vault, draft.projects, draft.kind);
    const projects = [...new Set(draft.projects)].sort();
    if (projects.some(p => p.startsWith("workspace:")) && !draft.workspacePath)
      throw new Error("Origin workspace path is required for fingerprint-bound knowledge");
    let current: LocalNote | null = null;
    if (draft.targetId) {
      current = vault.get(draft.targetId);
      if (current.historical || current.privacy === "restricted" || !current.path.startsWith("30_知识与经验/")) throw new Error("Only an existing current knowledge body can be updated");
      if (draft.baseHash !== current.rawHash) throw new Error("Base version changed; refresh the proposed difference");
      if (stable(current.projects.slice().sort()) !== stable(projects)) throw new Error("Project boundary changes require a separate decision");
    }
    const exact = vault.notes.find(n => !n.historical && vault.visible(n) && n.body.trim() === draft.body.trim()
      && stable(n.projects.slice().sort()) === stable(projects));
    const sameTopic = vault.notes.find(n => !n.historical && n.title === draft.title && stable(n.projects.slice().sort()) === stable(projects));
    if (!current && sameTopic && sameTopic !== exact) throw new Error("The same topic already exists; review an update with its ID and base hash");
    let action: CaptureChange["action"] = current ? "update" : "create";
    if (exact && (!current || exact.id === current.id)) { current = exact; action = "reuse"; }
    const id = current?.id ?? "local:" + digest(stable([draft.kind, draft.title, projects])).slice(0, 24);
    const path = current?.path ?? draft.path ?? "30_知识与经验/" + (draft.kind === "experience" ? "项目经验" : "资料与方法") + "/" + draft.title.replace(/[:]/gu, "：") + ".md";
    notePath(path);
    // Reading bodies do not contain their frontmatter. The caller supplies no protected fields.
    const priorSources = current?.sourceRefs.map(ref => ({ ref, readScope: "link_only" as const })) ?? [];
    const mergedSources = [...new Map([...priorSources, ...draft.sources].map(s => [s.ref, s])).values()];
    let proposedRaw: string;
    if (action === "reuse") proposedRaw = "";
    else if (current) {
      // Full current frontmatter is attached by previewCaptureFiles below, before the review hash is computed.
      proposedRaw = draft.body;
    } else {
      const header = { local_id: id, type: draft.kind, privacy: "internal", status: "unverified",
        projects, created_at: now, observed_at: draft.observedAt, sources: mergedSources,
        ...(projects.some(p => p.startsWith("workspace:")) ? { reuse_policy: "test_only + reversible_trial_only" } : {}),
        source_content_coverage: coverage(mergedSources) };
      proposedRaw = "---\n" + YAML.stringify(header, { defaultStringType: "QUOTE_DOUBLE" }) + "---\n" + draft.body.trim() + "\n";
    }
    return { id, title: draft.title, action, path, baseHash: current?.rawHash ?? null, proposedRaw,
      rawHash: digest(proposedRaw), currentBody: current?.body ?? null, proposedBody: draft.body.trim(),
      projects, sources: mergedSources, ...(draft.workspacePath ? { workspacePath: draft.workspacePath } : {}),
      possibleDuplicates: vault.search(draft.title + " " + draft.body.slice(0, 250), projects[0]).filter(n => n.id !== current?.id).slice(0, 3)
        .map(n => ({ id: n.id, title: n.title, path: n.path })) };
  });
  if (new Set(changes.map(c => c.id)).size !== changes.length || new Set(changes.map(c => c.path)).size !== changes.length)
    throw new Error("The batch proposes multiple writes to the same knowledge body");
  const base = { format: "local-vault-capture-preview" as const, version: 1 as const, vaultFingerprint: fingerprint(vault),
    changes, resultingStatus: "unverified" as const };
  return { ...base, previewHash: proof(base) };
}
export async function previewCaptureFiles(vault: LocalVault, drafts: CaptureDraft[]): Promise<CapturePreview> {
  if (!Array.isArray(drafts)) throw new Error("A capture batch is required");
  drafts = await Promise.all(drafts.map(async draft => {
    if (!draft.workspacePath) return draft;
    const fingerprint = await workspaceFingerprint(draft.workspacePath);
    const originProject = vault.projects.filter(p => !relative(p.root, draft.workspacePath!).startsWith("..")
      && !isAbsolute(relative(p.root, draft.workspacePath!))).sort((a, b) => b.root.length - a.root.length)[0];
    const projects = draft.projects.length ? draft.projects : [originProject?.id ?? fingerprint];
    if (projects.some(p => p.startsWith("workspace:")) && (projects.length !== 1 || projects[0] !== fingerprint))
      throw new Error("Origin workspace fingerprint mismatch");
    return { ...draft, projects };
  }));
  const preview = previewCapture(vault, drafts);
  for (const change of preview.changes) {
    if (change.action === "create") {
      if (await lstat(inside(vault.root, change.path)).then(() => true, () => false)) throw new Error("Capture destination is occupied");
    } else {
      const current = vault.get(change.id), raw = await readFile(await regular(vault.root, current.path), "utf8");
      if (digest(raw) !== change.baseHash) throw new Error("Reading note changed while preparing the preview");
      const original = matter(raw);
      const retained = new Map(current.sourceRefs.map(ref => [ref, { ref, readScope: "link_only" } as CaptureSource]));
      for (const source of Array.isArray(original.data.sources) ? original.data.sources : []) {
        if (source && typeof source.ref === "string" && ["link_only", "excerpt", "full", "project_result"].includes(source.readScope))
          retained.set(source.ref, source as CaptureSource);
      }
      const input = drafts[preview.changes.indexOf(change)]!;
      const additionalEvidence = input.sources.some(s => !retained.has(s.ref) || stable(retained.get(s.ref)) !== stable(s));
      change.sources = [...new Map([...retained.values(), ...input.sources].map(s => [s.ref, s])).values()];
      sourcesValid(change.sources);
      if (change.action === "reuse" && additionalEvidence) change.action = "update";
      if (change.action === "reuse") change.proposedRaw = raw;
      else {
        const data: Record<string, unknown> = { ...original.data, sources: change.sources,
          observed_at: input.observedAt, source_content_coverage: coverage(change.sources) };
        if (data.display_title !== undefined) data.display_title = change.title;
        change.proposedRaw = "---\n" + YAML.stringify(data, { defaultStringType: "QUOTE_DOUBLE" }) + "---\n" + change.proposedBody + "\n";
        vault.previewChange(change.id, current.rawHash, change.proposedRaw);
      }
      change.rawHash = digest(change.proposedRaw);
    }
  }
  const { previewHash: _prior, ...base } = preview; preview.previewHash = proof(base); return preview;
}
async function safeParent(root: string, path: string) {
  const target = inside(root, path), parts = path.split("/").slice(0, -1); let cursor = root;
  for (const part of parts) {
    cursor = join(cursor, part);
    const exists = await lstat(cursor).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });
    if (!exists) await mkdir(cursor, { mode: 0o700 });
    else if (exists.isSymbolicLink() || !exists.isDirectory()) throw new Error("Unsafe capture parent directory");
  }
  if (relative(await realpath(root), await realpath(dirname(target))).startsWith("..")) throw new Error("Capture path escaped the Vault");
  return target;
}
export async function applyCapture(vault: LocalVault, preview: CapturePreview, expectedHash: string, confirmed: boolean) {
  const { previewHash, ...base } = preview;
  if (!confirmed || previewHash !== expectedHash || proof(base) !== expectedHash || preview.vaultFingerprint !== fingerprint(vault)
    || preview.format !== "local-vault-capture-preview" || preview.version !== 1 || preview.resultingStatus !== "unverified"
    || !Array.isArray(preview.changes) || !preview.changes.length || preview.changes.length > 5) throw new Error("Exact preview and actual user confirmation are required");
  if (new Set(preview.changes.map(c => c.id)).size !== preview.changes.length
    || new Set(preview.changes.map(c => c.path)).size !== preview.changes.length) throw new Error("Duplicate targets in reviewed capture");
  const checked: Array<{ change: CaptureChange; path: string; previous: string | null; unchanged: boolean }> = [];
  for (const change of preview.changes) {
    if (!["create", "update", "reuse"].includes(change.action)) throw new Error("Unsupported capture action");
    notePath(change.path); bodyValid(change.title, change.proposedBody + "\n"); sourcesValid(change.sources);
    if (digest(change.proposedRaw) !== change.rawHash) throw new Error("Reviewed content hash mismatch");
    const parsed = matter(change.proposedRaw), id = parsed.data.context_router?.id ?? parsed.data.local_id;
    if (id !== change.id || parsed.content.trim() !== change.proposedBody) throw new Error("Reviewed body identity/content mismatch");
    if (change.action === "create") {
      const kind = parsed.data.type;
      scopeValid(vault, change.projects, kind);
      if (!["research", "experience"].includes(kind) || Object.keys(parsed.data).some(k => !createFields.has(k))
        || stable(parsed.data.projects) !== stable(change.projects)
        || change.id !== "local:" + digest(stable([kind, change.title, change.projects])).slice(0, 24)
        || !dateValid(parsed.data.created_at) || !dateValid(parsed.data.observed_at)
        || stable(parsed.data.sources) !== stable(change.sources)) throw new Error("New working note metadata differs from the reviewed capture");
    }
    if (change.projects.some(p => p.startsWith("workspace:"))) {
      if (!change.workspacePath || change.projects.length !== 1 || change.projects[0] !== await workspaceFingerprint(change.workspacePath)
        || parsed.data.reuse_policy !== "test_only + reversible_trial_only") throw new Error("Unregistered experience must remain bound to its origin workspace");
    }
    let path = change.path, previous: string | null = null;
    const current = vault.notes.find(n => n.id === change.id && !n.historical);
    if (current) { path = current.path; previous = await readFile(await regular(vault.root, path), "utf8"); }
    else previous = await readFile(inside(vault.root, path), "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });
    if (previous === change.proposedRaw) { checked.push({ change, path, previous, unchanged: true }); continue; }
    if (change.action === "reuse" || (change.action === "create" ? previous !== null : !current || digest(previous!) !== change.baseHash))
      throw new Error("Capture base/destination changed; preserve both versions and prepare a fresh difference");
    if (change.action === "update") vault.previewChange(change.id, change.baseHash!, change.proposedRaw);
    else if (parsed.data.context_router || parsed.data.status !== "unverified" || parsed.data.privacy !== "internal")
      throw new Error("New working notes cannot claim protected identity, approval or visibility");
    checked.push({ change, path, previous, unchanged: false });
  }
  const results = [];
  for (const item of checked) {
    if (item.unchanged) { results.push({ id: item.change.id, path: item.path, unchanged: true }); continue; }
    const target = await safeParent(vault.root, item.path);
    if (item.previous !== null) {
      const historyPath = "90_审计资料/正文原版本/" + digest(item.change.id).slice(0, 20) + "/" + digest(item.previous) + ".txt";
      const history = await safeParent(vault.root, historyPath);
      try { await writeFile(history, item.previous, { flag: "wx", mode: 0o600 }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(history, "utf8") !== item.previous) throw e; }
    }
    const handle = await open(target, item.previous === null ? constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
      : constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      if (item.previous !== null && digest(await handle.readFile("utf8")) !== item.change.baseHash) throw new Error("Note changed immediately before write");
      const body = Buffer.from(item.change.proposedRaw);
      let offset = 0;
      while (offset < body.length) { const written = await handle.write(body, offset, body.length - offset, offset); if (!written.bytesWritten) throw new Error("Knowledge write stopped"); offset += written.bytesWritten; }
      await handle.truncate(body.length); await handle.sync();
    } finally { await handle.close(); }
    if (await readFile(await regular(vault.root, item.path), "utf8") !== item.change.proposedRaw) throw new Error("Saved knowledge readback mismatch");
    results.push({ id: item.change.id, path: item.path, unchanged: false });
  }
  return { results, saved: results.filter(r => !r.unchanged).length, resultingStatus: "unverified", canonicalStoreChanged: false };
}
