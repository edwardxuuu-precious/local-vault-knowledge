# Local Vault Knowledge

版本 1.1.0 本地候选，尚未发布。此次分发包含确认后保存、独立 Hook、项目启动片段，以及首条任务的一次按问题补查规则。Codex 接入使用 [CODEX-SETUP.md](CODEX-SETUP.md)，实际验证与发布边界见 [RELEASE.md](RELEASE.md)。

本地优先的 Markdown 知识工具。人在 Obsidian 或其他编辑器中维护正文，AI 按任务读取关键事实、边界、证据与未结事项。工具使用 Node.js 24 及以上版本。

## 开始使用

~~~bash
npm install
npm run build
node dist/cli.mjs vault init --destination "/absolute/path/My Knowledge" --confirm-new-vault
node dist/cli.mjs --root "/absolute/path/My Knowledge" vault search "关键事实"
~~~

init 只接受新的目录。已有配置缺失或指向不存在的 Vault 时会报错，读取不会另建替代库。

日常入口为首页、个人偏好、项目、知识与经验、待确认和收件箱。90_系统 保存身份、保护状态、历史与账本；90_审计资料 保存追溯入口。两者退出默认搜索。新用户可以先在收件箱写笔记，再归入知识目录。

刷新同时维护 Obsidian 的排除目录设置，保留其他已有设置；系统与审计区退出默认搜索、图谱和未链接提及，证据链接仍可展开。对应行为见 [Obsidian 官方设置说明](https://obsidian.md/help/settings)。移动包只携带这一项阅读范围配置，不携带桌面工作区或插件设置。

普通笔记使用如下最小格式；local_id 保持稳定，projects 的星号表示通用参考。默认隐私为 internal，内容默认待验证。

~~~yaml
---
local_id: evidence-before-claims
projects: ["*"]
---
~~~

正文按需要写“结论与用法、适用边界、未结事项、证据定位”。方法保留必要动作、验收与停止条件。当前项目事实以原项目为准；模型建议、历史状态与真实效果分别判断。

## 按需检索与修改预览

~~~bash
node dist/cli.mjs --root "/absolute/path/My Knowledge" vault search "设备锁屏检查" --project project-id
node dist/cli.mjs --root "/absolute/path/My Knowledge" vault get "stable-note-id"
node dist/cli.mjs --root "/absolute/path/My Knowledge" vault context "本次任务" --workspace "/absolute/path/project"
node dist/cli.mjs --root "/absolute/path/My Knowledge" vault change-preview "stable-note-id" --base-hash HASH --file proposed.md
node dist/cli.mjs --root "/absolute/path/My Knowledge" vault refresh
~~~

检索返回最多五个相关片段与完整适用边界、未结事项；方法采用前用 get 展开。项目匹配优先，共用章节标题不作为正文片段。上下文只有读取了全部明确配置的真源文件后才报告 truthAvailable=true，目录存在不算真源已加载；缺失、超长或含可能凭据的文件返回 unavailableReason，需要另行核对相关安全章节。未知与冲突保持明确。

读取不初始化写服务、不修改 SQLite/WAL、笔记清单或维护队列。刷新仅更新导航和默认阅读范围；内容不变时不重写文件。修改预览检查基础哈希、重复内容和受保护字段，只返回差异。

已有 Context Router 用户可以传入其代码目录、数据根或 Vault。原知识版本、ID、状态和事件账本保持原边界。此工具独立于自动 Hook、预检、收尾与旧 MCP；使用不会改变它们的启停配置。

迁移旧阅读结构时，使用 vault organize-preview，核对移动位置和真实差异，再把完整预览写入临时 JSON，通过 vault organize-apply --file PREVIEW --expected-preview-hash HASH 应用。该接口限于阅读路径与非保护展示字段；不同对象的状态裁决仍走原人工流程。

## 日常资料与经验

独立轻量 Hook 通过 UserPromptSubmit 事件在相关项目任务消息开始时查询经验。它默认只带入最多2条、合计2400字符；简单翻译、时间查询和纯确认跳过，无命中不强行引用。流程、截断片段及重要边界仍需 get 展开。Hook 先核对规范身份、状态和隐私；原项目真源仅定位，使用前另行核对。

Hook 使用内存数据库视图，包括 WAL 已提交变化；不写数据库副本、缓存、回执、运行日志或备份。重复调用不会改变 Vault 文件、历史或备份数量。异常、并发变化或超时只报告查询未完成，允许其他已授权工作继续；没有自动保存或 Stop 收尾。

本机 Hook 由 local-knowledge Skill 的 scripts/hook.mjs 接入，连接与开关保存在 ~/.codex/local-knowledge.json。宿主要求真实用户审阅和信任新 Hook；在终端启动 codex 后通过 /hooks 完成，再用新 Desktop 会话验证自动注入。只安装配置或运行隔离用例不能宣称自动激活。旧 Context Router 生命周期和插件开关保持关闭。

Desktop 验收应在目标项目的新聊天输入框发送第一条实际用户消息，并让该聊天仅检查已经收到的上下文，禁止工具、文件读取和手动检索。只有宿主另行附加的开发者上下文中确实包含 `source: local-knowledge-hook/v1` 的 JSON，才计为自动收到；提示词或 AGENTS.md 提及该名称不计。`projectTruthLoaded=false` 表示仅定位项目真源，不能据此声称真源已读。

本机 Desktop 26.1007.71326 / CLI 0.162.0-alpha.17.2 的工具建聊入口有独立限制：`create_thread` 首条任务以 `FunctionCallOutput` 传入，实际触发为 `app_tool_create_thread`；同一聊天从输入框发送的消息以 `UserInput` 传入，触发为 `composer`，能够收到 UserPromptSubmit Hook 上下文。工具建聊首条缺少片段不能直接判定配置或信任失效，也不构成该入口已支持自动注入的证明。需要用输入框完成验收，并把工具建聊入口的覆盖限制单列；隔离重放只用于诊断。宿主版本或输入路径变化后需重新核对。

独立入口另支持 `SessionStart` 的 `startup` 事件，用于在首条任务没有 UserPromptSubmit 事件时提供项目启动上下文。它只读取已登记项目中可用的 `type: project` 正文，优先当前事实，最多1条、合计仍受2400字符默认上限约束；不读取聊天记录，也不把全局经验或其他项目正文当作启动材料。未登记项目、没有可用项目正文，以及 resume、fork、clear、compact 事件均不补发启动片段。原输入框的按任务查询规则保持。

启动片段仍使用 `source: local-knowledge-hook/v1`，并明确附带 `trigger: SessionStart`、`retrievalScope: project_bootstrap`、`taskQueryAvailable: false`。它证明项目启动材料被交付，不能宣称已经按工具首条任务的文本检索经验或读取项目真源。普通输入框首轮也可能同时收到启动片段和按任务查询片段；不使用磁盘去重状态。

按任务查询完成后明确附带 `trigger: UserPromptSubmit`、`retrievalScope: task_query`、`taskQueryAvailable: true`；查询无命中也返回 `hits: []`，以区别未查询、跳过或读取失败。简单自包含任务仍跳过；启动片段和任务检索的 `projectTruthLoaded` 均为 false，不代表已读项目真源。本轮已有任务检索时直接复用；只有启动片段时，local-knowledge Skill 在任务需要知识且允许工具的前提下，使用实际核心问题调用一次 context。CLI 补查完成属于首轮任务检索，不能称为模型开始前的零工具 Hook 注入；任务禁止工具、无命中或补查失败时如实保留边界，不连续补查。

验收需分别检查三类：同一项目两个不同问题实际调用不同查询并返回对应知识；输入框首轮已有任务查询（含无命中）时不再补查；仅启动片段时才按委派任务补查一次。工具建聊实机验收仍应使用新的 create_thread 首轮；自动 Hook 验收要求子聊天工具调用为0，Skill 补查验收则核对实际 context 参数、结果与调用次数，二者分别报告。

SessionStart 处理命令为 `node /absolute/reader/src/interfaces/local-knowledge-hook-command.mjs --event SessionStart`，配置 matcher 为 `^startup$`。新事件必须经宿主真实用户审核信任；源码支持、隔离测试和配置存在均不等于真实工具建聊验收通过。可将该处理器的 `additionalContextLimit` 设为0以避免宿主另存溢出文件，前提是保留处理器已有的字符硬上限。启用后应使用真实 `create_thread` 首条任务进行零工具检查，并核对宿主独立附加的开发者上下文；不得把手动检索结果填入任务提示词替代验收。旧 Context Router 继续关闭。

在相关项目中，先按任务查找已有经验并核对当前项目真源。资料输入可以是链接、文档片段或实际工作结果；保存建议只包含关键结论、适用范围、未结事项和证据定位。

本机 Codex 使用 local-knowledge Skill 主动调用这些 CLI；本机 readerRoot 由 ~/.codex/local-knowledge.json 明确配置。用户可以直接提出“整理这份资料”或“参考已有经验处理这个问题”，不必手动输入命令。Skill 的可发现性、客户端安装及连接配置应在每台设备分别验证，工具本身不启用后台采集。

新增或更新先形成一批预览：同题已有正文时选择原 ID 与基础哈希进行更新；完全重复复用原条目；可能重复列出候选供判断。项目经验保留原项目范围，研究资料可以作为待验证建议。只保存链接时必须标记 link_only，阅读片段使用 excerpt，不能包装成已阅读全文。

未登记项目可提供 workspacePath 与空的 projects。经验绑定匿名工作区指纹，仅在原工作区以 test_only + reversible_trial_only 方式使用；登记项目按原项目 ID 调用，当前事实仍从原项目核对。

~~~bash
node dist/cli.mjs --root VAULT vault capture-preview --file drafts.json
node dist/cli.mjs --root VAULT vault capture-save --preview reviewed-preview.json --expected-preview-hash HASH --confirm
node dist/cli.mjs --root VAULT vault refresh
~~~

capture-save 仅在真实用户确认具体预览后调用。预览绑定正文、基础版本、来源与范围；独立编辑后需要刷新差异。无变化保存不新增文件，更新时只保留一份按内容哈希去重的旧正文原字节。它只写当前阅读正文及该正文的原版本，不修改规范 SQLite、原知识身份、审批状态或全库备份。

单条输入示例（日期、来源和范围应来自实际任务）：

~~~json
[{
  "title": "设备导入前的状态检查",
  "kind": "experience",
  "projects": ["demo-project"],
  "observedAt": "2026-10-14T10:00:00.000Z",
  "sources": [{"ref": "/absolute/path/project/accepted-result.md", "readScope": "project_result"}],
  "body": "# 设备导入前的状态检查\n\n## 结论与用法\n记录实际观察及必要动作。\n\n## 适用边界\n仅本项目已观察场景。\n\n## 未结事项\n其他场景效果未知。\n"
}]
~~~

更新已有正文时增加 targetId 与 baseHash；保留原创建时间、身份、保护状态与来源。读取与检索不会登记使用事件；结果回收只在出现实质新增时更新正文，持续未知无需重复追加。

## 私人换机与手机阅读

~~~bash
node dist/cli.mjs --root "/absolute/path/My Knowledge" vault export --kind full --destination "/outside-vault/full.tar.gz"
node dist/cli.mjs --root "/absolute/path/My Knowledge" vault export --kind mobile --destination "/outside-vault/mobile.tar.gz"
node dist/cli.mjs vault inspect "/outside-vault/mobile.tar.gz"
node dist/cli.mjs vault import "/outside-vault/mobile.tar.gz" --destination "/new/working-copy" --expected-id PACKAGE_ID
~~~

完整包保存一致数据库快照，包括 WAL 中已提交事件；移动包只带选定正文、必要附件和基础版本。包内含文件校验及原创建时间元数据。导入保留原 created_at；文件系统新文件的创建时间可能由目标系统决定，原时间仍保留在包和工作副本元数据中。

手机只需 Obsidian 或 Markdown 编辑器：在电脑上验包并解出移动工作副本，再把文件夹通过本机文件传输方式放入手机的 Obsidian 本地目录。手机无需运行 Node 或 MCP。此操作还需在实际设备验收。

电脑读取带回的移动工作副本：

~~~bash
node dist/cli.mjs --root "/absolute/path/My Knowledge" vault returned-edits "/mobile/working-copy"
~~~

单端修改和双端独立修改分别显示。原路径找不到时按稳定 ID 寻找改名后的文件；基础哈希或受保护元数据不一致时阻止覆盖。新增收件箱文件单列。返回操作只预览，原两端内容保留。

完整包导入首先是工作副本，需要人工 CLI 的 --human-confirm。活动库切换由人执行：

~~~bash
node dist/cli.mjs vault import FULL_PACKAGE --destination NEW_VAULT --expected-id PACKAGE_ID --human-confirm
node dist/cli.mjs vault bind-import FULL_PACKAGE --destination NEW_VAULT --expected-id PACKAGE_ID \
  --reviewer YOUR_NAME --confirm-source-frozen --backup-path OUTSIDE_BACKUP_DIR --code-root CODE_DIR
~~~

切换前停止旧主库写入。bind-import 校验完整包与未修改的副本，只更新新库的本机绑定并保存旧配置；事件账本、历史回执与知识生命周期保持。离线环境中“旧库已停止”是人工声明，不是跨设备互斥证明。Hook/MCP 设置继续由使用者另行决定。

## 精选内容公开

examples/公开草案.json 展示输入格式。选择正文 ID、当前 rawHash、拟公开正文、来源 URL 与权利依据。公开正文必须包含适用边界；正文或来源发生变化时重新预览。

~~~bash
node dist/cli.mjs --root VAULT vault public-preview --file selected-drafts.json
node dist/cli.mjs --root VAULT vault public-export --file selected-drafts.json \
  --expected-preview-hash HASH --reviewer YOUR_NAME --confirm --destination OUTSIDE_PUBLIC_PACKAGE
~~~

许可未知、私人路径、内部系统引用、凭据模式或来源漂移会阻止导出。确认绑定完整正文和来源版本。公开包仅含选中正文、边界、证据状态、允许公开的来源及 CC BY 4.0 标识。私人配置、账本、签名回执与未选正文留在私人侧。实际网站、GitHub 或其他平台发布由使用者决定。

## AI 客户端与扩展

dist/mcp.mjs 导出 createLocalVaultMcpServer(root)，由调用者在明确启用时接入传输。工厂本身不启动服务。只有 vault_search、vault_get、vault_context、vault_preview_change 四个只读工具；审批、恢复、发布和任意 SQL/文件写入不进入 MCP。

首版使用调用级内存全文索引、中文词组与别名。语义检索适配、模型下载、实时同步和自动学习保留为按需求扩展项。参考 [PARA](https://fortelabs.com/blog/para/)、[Basic Memory](https://github.com/basicmachines-co/basic-memory)、[OpenClaw Memory](https://docs.openclaw.ai/concepts/memory)、[QMD](https://github.com/tobi/qmd)、[Graphiti](https://github.com/getzep/graphiti) 的组织、记忆和追溯机制，独立实现工具。

## 验证与许可

~~~bash
npm run typecheck
npm test
npm run build
npm run check:distribution
~~~

测试覆盖只读字节保持、中文与项目范围、更新与未知、改名、冲突、无变化刷新、WAL、损坏包、移动编辑、公开确认与隔离人工切换。CI 配置包含 macOS、Windows、Linux；配置存在不代表各平台已经验收。

工具源码采用 MIT。依赖保留各自许可。知识公开许可与工具许可分别维护；外部原文只有许可明确时才进入公开包。
