# Codex 可选接入

先在本机审阅工具源码和 Skill。此候选不安装客户端、不复制私人知识、不写宿主信任，也不启用旧 Context Router。命令中的绝对路径按实际设备替换；Node.js 版本须为 24 或以上。

## 连接已有或新建 Vault

在工具目录执行 `npm ci`、`npm run build`。已有 Vault 继续使用原目录；新用户才运行 README 中的 `vault init`。将 `examples/reader-locator.json` 的 `root` 改成所选 Vault 的 `90_系统` 绝对路径，保存为工具目录下的 `.context-router-storage.json`。该文件只有读取位置，不启动 Router。

先通过 CLI 验证读取：

~~~bash
node dist/cli.mjs --root "/absolute/path/My Knowledge" vault search "关键事实"
~~~

使用代码目录作为 `--root` 时，读取将通过上述 locator 找到相同 Vault。配置目录不存在、身份或保护状态不一致时保留错误，不初始化替代库。

## 安装 Skill

审阅 `skills/local-knowledge/` 后，将这一整个目录放入本机 Codex 的 `skills/local-knowledge/`。默认用户目录是 `~/.codex/skills/local-knowledge/`；设置了 `CODEX_HOME` 时使用它的 `skills/` 目录。已有同名 Skill 时先核对具体差异，由使用者决定更新，保留无关配置。

将 `examples/local-knowledge.json` 中的 `readerRoot` 改成工具代码目录的绝对路径，保存为 Codex 用户配置目录中的 `local-knowledge.json`。默认 `hook.enabled=false`，可以先用 Skill 的 `scripts/knowledge.mjs` 验证 `search`、`get` 和 `context`。该连接配置由使用者维护，不进入代码仓库。

~~~bash
node "/absolute/path/local-vault-knowledge/skills/local-knowledge/scripts/knowledge.mjs" context "本次需要解决的实际问题" --workspace "/absolute/path/project"
~~~

日常保存按 Skill 的确认流程执行：先向用户展示正文差异、来源、阅读程度、范围和去重方案，确认同一预览后才调用 `capture-save`，随后 `get` 回读。有正文改动才刷新导航。软件安装和读取成功不构成知识审批或真实效果证据。

## 可选 Hook

`examples/hooks.json` 提供两个有界、同步的 command handler。替换脚本绝对路径后，只将这两个事件合并到本机已有 Hook 配置，保留其他内容；同一事件的重复配置会分别运行。Windows 路径和 Node 可执行文件位置按本机设置，示例不预设安装位置。

- `UserPromptSubmit` 按实际任务查询，默认最多 2 条、2400 字符。
- `SessionStart` 只匹配 `^startup$`，最多 1 条已登记项目正文。它只交付启动材料，不含工具建聊首条任务文本。

处理器自身保留字符硬上限；示例的 `additionalContextLimit=0` 让这一有界上下文直接交付，避免宿主为溢出另存文件。不要移除此硬上限。Hook 配置位置、信任和这些字段以 [OpenAI 官方 Hook 文档](https://learn.chatgpt.com/docs/hooks) 为准；核对日期：2026-10-15。

SessionStart 需要 Vault 中的项目注册表与普通项目正文。`examples/projects.yaml` 和 `examples/project-facts.md` 仅说明最小格式：向已有 `90_系统/config/projects.yaml` 合并项目记录，在 `20_项目/` 保存该项目阅读摘要，保留现有注册项与知识 ID。`root` 必须指向实际项目目录。项目真源仍从该目录核对，阅读摘要不替代原项目文件。

在终端运行交互式 `codex`，通过 CLI 的 `/hooks` 审阅和信任新增定义。确认配置后，把本机 `local-knowledge.json` 的 `hook.enabled` 设为 `true`，重启 Desktop，并在新聊天验证。新定义或定义变化后仍需真实使用者信任；不绕过信任流程。

## 复用与验收边界

Skill 明确区分三种输入：

| 本轮收到的上下文 | 后续动作 |
| --- | --- |
| `retrievalScope=task_query`、`taskQueryAvailable=true`，包括 `hits=[]` | 复用本轮查询，不重复 `context` |
| 只有 `SessionStart` / `project_bootstrap` / `taskQueryAvailable=false` | 相关任务且允许工具时，以实际问题补查一次 `context` |
| 明确禁止工具、无命中或补查失败 | 如实报告任务检索边界，不连续补查 |

`projectTruthLoaded=false` 表示真源尚未读取。启动片段、按任务 Hook 查询与模型开始后的 Skill 补查分别报告；CLI 补查不称为零工具自动注入。

维护环境已有输入框、工具建聊启动材料及首条任务补查的实机证据，这份候选沿用对应源码与 Skill，不重复那些验收。不同设备、宿主版本或输入路径的实际行为仍需在目标端核对；源码、构建和隔离检查只证明分发链可以运行。
