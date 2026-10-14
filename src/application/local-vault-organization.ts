import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import matter from "gray-matter";
import YAML from "yaml";
import { LocalVault, type LocalNote } from "./local-vault.js";
import { digest, inside, regular, stable, writeChanged } from "./local-vault-files.js";

export interface OrganizationMove { id: string; from: string; to: string; rawHash: string; raw: string; proposedRaw: string; reason: string }
export interface OrganizationPreview { version: 1; previewHash: string; moves: OrganizationMove[]; pending: Array<{ title: string; ids: string[]; paths: string[]; reason: string }> }
const projectNames = (vault: LocalVault) => new Map(vault.projects.map(p => [p.id, p.name.replace(/[\\/:*?"<>|]/gu, "-")]));
function category(note: LocalNote, names: Map<string, string>): string {
  if (note.kind === "personal") return "10_个人";
  if (note.kind === "project") return "20_项目";
  const local = note.projects.find(p => p !== "*" && !/research/u.test(p));
  if (local) return "30_知识与经验/项目经验/" + (names.get(local) ?? local);
  if (/Meta|广告|销售|利润|获客|营销|线索/u.test(note.title)) return "30_知识与经验/增长营销";
  if (/SEO|GEO|长尾|搜索|内链/u.test(note.title)) return "30_知识与经验/搜索与内容";
  if (/创作者|视频|社媒|社交|品牌|Hook/u.test(note.title)) return "30_知识与经验/内容与创作者";
  if (/产品|需求|场景|关系|沟通|访谈/u.test(note.title)) return "30_知识与经验/产品与需求";
  return "30_知识与经验/软件与协作";
}
function shortName(title: string): string {
  return title.replace(/[\\/:*?"<>|#\[\]]/gu, " ").replace(/[。？?！!]+$/u, "").replace(/\s+/gu, " ").trim().slice(0, 48) || "未命名知识";
}
export async function previewOrganization(vault: LocalVault, titles: Record<string, string> = {}): Promise<OrganizationPreview> {
  const moves: OrganizationMove[] = [], names = projectNames(vault), occupied = new Set<string>(), groups = new Map<string, LocalNote[]>();
  const eligible = vault.notes.filter(n => !n.historical && /^(00_个人标准|10_项目手册|20_可复用经验|30_研究主题|40_知识正文)\//u.test(n.path));
  for (const note of eligible) groups.set(stable([note.title, note.projects.slice().sort()]), [...(groups.get(stable([note.title, note.projects.slice().sort()])) ?? []), note]);
  const pending = [...groups.values()].filter(g => g.length > 1 && new Set(g.flatMap(n => n.objectIds)).size > 1
    && !g.some(n => n.path.startsWith("30_研究主题/"))).map(g => ({ title: g[0]!.title, ids: g.map(n => n.id),
      paths: g.map(n => n.path), reason: "不同知识身份或证据状态；仅合并阅读展示，不自动合并canonical或裁决状态。" }));
  for (const note of eligible) {
    if (note.status === "conflict") continue;
    const raw = await readFile(await regular(vault.root, note.path), "utf8");
    if (digest(raw) !== note.rawHash) throw new Error("Note changed during organization preview");
    const title = titles[note.id] ?? titles[note.path] ?? note.title;
    let to = category(note, names) + "/" + shortName(title) + ".md", ordinal = 2;
    while (occupied.has(to)) to = category(note, names) + "/" + shortName(title) + "（来源" + ordinal++ + "）.md";
    occupied.add(to);
    const parsed = matter(raw);
    const data = { ...parsed.data, local_id: parsed.data.local_id ?? note.id, display_title: title,
      aliases: [...new Set([...(Array.isArray(parsed.data.aliases) ? parsed.data.aliases : []), note.path.replace(/\.md$/u, ""), note.path.split("/").at(-1)!.replace(/\.md$/u, "")])] };
    const proposedRaw = "---\n" + YAML.stringify(data) + "---\n" + parsed.content;
    moves.push({ id: note.id, from: note.path, to, rawHash: note.rawHash, raw, proposedRaw, reason: "按用途重命名；保留原身份、正文和保护字段。" });
  }
  return { version: 1, previewHash: digest(stable(moves.map(({ raw, proposedRaw, ...m }) => ({ ...m, proposedHash: digest(proposedRaw) })))), moves, pending };
}
/** Changes only reading paths, unprotected presentation fields and links. Canonical lifecycle stays untouched. */
export async function applyOrganization(vault: LocalVault, preview: OrganizationPreview, expectedHash: string) {
  if (preview.previewHash !== expectedHash) throw new Error("Organization preview identity mismatch");
  const actualHash = digest(stable(preview.moves.map(({ raw, proposedRaw, ...m }) => ({ ...m, proposedHash: digest(proposedRaw) }))));
  if (actualHash !== expectedHash) throw new Error("Organization payload changed");
  for (const move of preview.moves) {
    if (move.from !== vault.get(move.id).path
      || !/^(00_个人标准|10_项目手册|20_可复用经验|30_研究主题|40_知识正文|00_收件箱|10_个人|20_项目|30_知识与经验)\//u.test(move.from)
      || !/^(00_收件箱|10_个人|20_项目|30_知识与经验)\//u.test(move.to))
      throw new Error("Organization is limited to the reviewed reading note and reading destinations");
    if (digest(await readFile(await regular(vault.root, move.from))) !== move.rawHash) throw new Error("Source changed: " + move.from);
    if (await lstat(inside(vault.root, move.to)).then(() => true, () => false)) throw new Error("Occupied destination: " + move.to);
    const original = matter(move.raw).data, next = matter(move.proposedRaw).data;
    for (const key of Object.keys(vault.get(move.id).protectedFields)) if (stable(original[key]) !== stable(next[key])) throw new Error("Protected field changed");
  }
  const changed: OrganizationMove[] = [];
  try {
    for (const move of preview.moves) {
      if (digest(await readFile(await regular(vault.root, move.from))) !== move.rawHash) throw new Error("Concurrent edit: " + move.from);
      await mkdir(dirname(inside(vault.root, move.to)), { recursive: true });
      await rename(inside(vault.root, move.from), inside(vault.root, move.to)); changed.push(move);
      await writeChanged(inside(vault.root, move.to), move.proposedRaw);
    }
  } catch (error) {
    for (const move of changed.reverse()) {
      const path = inside(vault.root, move.to);
      if (await lstat(path).then(() => true, () => false)) {
        const current = await readFile(path, "utf8");
        if (digest(current) !== digest(move.proposedRaw) && digest(current) !== move.rawHash)
          throw new Error("Concurrent edit preserved at new path; manual recovery required");
        await writeFile(path, move.raw); await rename(path, inside(vault.root, move.from));
      }
    }
    throw error;
  }
  // Old managed records retain their metadata and both body baselines.
  if (vault.system) {
    const path = join(vault.system, "vault-notes/manifest.json"), raw = await readFile(path, "utf8");
    const manifest = JSON.parse(raw) as { records: Record<string, { metadata: { id: string }; relativePath: string }> };
    for (const record of Object.values(manifest.records)) {
      const move = preview.moves.find(m => m.id === record.metadata.id); if (move) record.relativePath = move.to;
    }
    await writeChanged(path, JSON.stringify(manifest, null, 2) + "\n");
    await writeChanged(join(vault.system, "config/vault-presentation.json"), '{"version":1,"mode":"local_first"}\n');
  }
  return { moved: changed.length, pending: preview.pending, canonicalStatesChanged: false };
}
