import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { LocalVault } from "./local-vault.js";
import { writeChanged, regular } from "./local-vault-files.js";

export const defaultReadingExclusions = ["90_系统/", "90_审计资料/"];
async function refreshReadingScope(vault: LocalVault): Promise<boolean> {
  const folder = await lstat(join(vault.root, ".obsidian")).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null; throw e;
  });
  if (folder && (!folder.isDirectory() || folder.isSymbolicLink())) throw new Error("Unsafe Obsidian configuration folder");
  const path = ".obsidian/app.json";
  const exists = await lstat(join(vault.root, path)).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null; throw e;
  });
  const settings = exists ? JSON.parse(await readFile(await regular(vault.root, path), "utf8")) as Record<string, unknown> : {};
  const filters = settings.userIgnoreFilters ?? [];
  if (!Array.isArray(filters) || filters.some(f => typeof f !== "string")) throw new Error("Invalid Obsidian exclusion settings");
  const missing = defaultReadingExclusions.filter(f => !filters.includes(f) && !filters.includes(f.replace(/\/$/u, "")));
  if (!missing.length) return false;
  settings.userIgnoreFilters = [...filters, ...missing];
  return writeChanged(join(vault.root, path), JSON.stringify(settings, null, 2) + "\n");
}

const link = (path: string, title: string) => "[[" + path.replace(/\.md$/u, "") + "|" + title.replace(/\|/gu, " ") + "]]";
/** Navigation is deterministic. Existing editable bodies are never rendered or overwritten here. */
export async function refreshLocalNavigation(vault: LocalVault) {
  const generated: Record<string, string> = {};
  generated["首页.md"] = [
    "# 我的知识库", "", "Context Router 自动功能保持关闭。这里保存关键事实、适用边界与未结事项。",
    "", "- [[10_个人/索引|我的偏好]]", "- [[20_项目/索引|正在做的项目]]",
    "- [[30_知识与经验/索引|查找方法与经验]]", "- [[40_待确认/待确认|待我决定]]",
    "", "[[00_收件箱/索引|收件箱]] · [[如何使用|使用说明]]",
    "", "原始证据保留在系统与审计区。知识状态与实际效果分别判断。",
  ].join("\n") + "\n";
  generated["00_收件箱/索引.md"] = "# 收件箱\n\n保存明确需要留存的资料。整理时先匹配已有条目，只有实质新增才形成正文。\n\n"
    + vault.notes.filter(n => n.kind === "inbox" && !n.historical).map(n => "- " + link(n.path, n.title)).join("\n") + "\n";
  generated["10_个人/索引.md"] = "# 我的偏好\n\n个人原则用于协作和评价；项目当前事实仍由原项目决定。\n\n"
    + vault.notes.filter(n => n.kind === "personal" && !n.historical).map(n => "- " + link(n.path, n.title)).join("\n") + "\n";
  generated["20_项目/索引.md"] = "# 项目入口\n\n每个项目保留当前真源位置、相关知识与关键未结事项。\n\n"
    + vault.notes.filter(n => n.kind === "project" && !n.historical).map(n => "- " + link(n.path, n.title)).join("\n") + "\n";
  const groups = new Map<string, typeof vault.notes>();
  for (const n of vault.notes.filter(n => !n.historical && n.path.startsWith("30_知识与经验/"))) {
    const group = n.path.split("/")[1] ?? "其他";
    groups.set(group, [...(groups.get(group) ?? []), n]);
  }
  generated["30_知识与经验/索引.md"] = "# 知识与经验\n\n同一问题维护一份当前正文。来源状态、适用范围与实际效果随正文说明。\n\n"
    + [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, notes]) => "## " + name + "\n\n"
      + notes.map(n => "- " + link(n.path, n.title)).join("\n")).join("\n\n") + "\n";
  generated["如何使用.md"] = [
    "# 如何使用", "", "## 阅读与编辑", "",
    "从首页进入个人偏好、项目、方法或待确认。直接编辑正文；保留身份、来源、状态和原创建时间。",
    "编辑后的内容按待验证材料使用，原始版本和保护状态保留。真正需要决定的差异见待确认页。",
    "系统与审计目录默认退出 Obsidian 搜索、图谱和未链接提及；仍可沿证据链接查看。",
    "", "## 让 AI 按需使用", "",
    "Context Router 的 Hook、MCP、自动预检与收尾保持关闭。当前 Mac 的 Codex 在相关项目任务中主动查本地经验，关键新增先提出建议，确认后保存。",
    "独立轻量 Hook 在相关任务消息开始时只读查询，默认带入最多2条、合计2400字符。Hook 已带入时先使用该批次；流程和重要边界采用前展开正文。",
    "此入口不保存运行状态、过程日志、回执或备份；新 Hook 需在 Codex 的真实用户信任流程中启用，配置与隔离通过不代表宿主已激活。",
    "从代码或工具目录运行以下命令；把路径替换为本机配置位置。",
    "", "~~~bash", 'node dist/cli.mjs --root "<配置目录或Vault>" vault search "设备锁屏检查" --project fitness-app',
    'node dist/cli.mjs --root "<配置目录或Vault>" vault context "本次任务" --workspace "<项目目录>"',
    'node dist/cli.mjs --root "<配置目录或Vault>" vault get "<正文ID>"', "~~~",
    "", "先查相关片段，再展开完整正文；流程类资料采用前要读全必要步骤。项目真源优先，未知保持未知。",
    "", "## 保存资料", "",
    "明确要求保存的资料先形成用途、来源、边界和去重预览，确认后再归入正文。重复内容复用原条目。",
    "把链接、文档片段或实际工作结果交给 AI；它提出关键内容、适用范围和合并建议，你确认后保存。",
    "相关项目先查已有经验；出现新结果或反证时更新同一正文。新资料默认私有、待验证，持续未知不追加过程记录。",
    "", "## 手动换设备", "",
    "使用私人完整包或移动阅读包。移动修改带回主设备后比较基础哈希；两端独立修改时显示双方差异。",
    "完整包先隔离验包；活动库恢复和切换由人工 CLI 完成。Obsidian 登录账号本身不会搬运本地资料。",
    "", "## 精选公开", "",
    "工具可开源；个人资料默认私有。只导出明确选中、许可清楚、脱敏并确认过的知识版本。",
    "公开资格与可信度分别维护。私人账本、回执、路径与原始备份留在私人侧。",
    "", "返回 [[首页]]。",
  ].join("\n") + "\n";
  let changed = await refreshReadingScope(vault) ? 1 : 0;
  for (const [path, body] of Object.entries(generated)) if (await writeChanged(join(vault.root, path), body)) changed++;
  return { changed, generatedPages: Object.keys(generated), readingConfiguration: [".obsidian/app.json"], visibleObjectCount: vault.notes.filter(n => !n.historical).length,
    totalVisibleObjectCount: vault.notes.length, humanKnowledgeGroupCount: vault.notes.filter(n => !n.historical).length,
    collapsedSourceCount: 0, rawAuditObjectCount: vault.notes.filter(n => n.historical).length, vaultPath: vault.root };
}
export async function usesLocalPresentation(vault: string): Promise<boolean> {
  const data = await readFile(join(vault, "90_系统/config/vault-presentation.json"), "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null; throw e;
  });
  if (data === null) return false;
  const parsed = JSON.parse(data) as { version: number; mode: string };
  if (parsed.version !== 1 || parsed.mode !== "local_first") throw new Error("Unknown Vault presentation mode");
  return true;
}
