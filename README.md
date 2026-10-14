# Local Vault Knowledge

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

检索返回最多五个相关片段与完整适用边界、未结事项；方法采用前用 get 展开。上下文只有读取了明确配置的真源文件后才报告 truthAvailable=true，目录存在不算真源已加载。未知与冲突保持明确。

读取不初始化写服务、不修改 SQLite/WAL、笔记清单或维护队列。刷新仅更新导航和默认阅读范围；内容不变时不重写文件。修改预览检查基础哈希、重复内容和受保护字段，只返回差异。

已有 Context Router 用户可以传入其代码目录、数据根或 Vault。原知识版本、ID、状态和事件账本保持原边界。此工具独立于自动 Hook、预检、收尾与旧 MCP；使用不会改变它们的启停配置。

迁移旧阅读结构时，使用 vault organize-preview，核对移动位置和真实差异，再把完整预览写入临时 JSON，通过 vault organize-apply --file PREVIEW --expected-preview-hash HASH 应用。该接口限于阅读路径与非保护展示字段；不同对象的状态裁决仍走原人工流程。

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
~~~

测试覆盖只读字节保持、中文与项目范围、更新与未知、改名、冲突、无变化刷新、WAL、损坏包、移动编辑、公开确认与隔离人工切换。CI 配置包含 macOS、Windows、Linux；配置存在不代表各平台已经验收。

工具源码采用 MIT。依赖保留各自许可。知识公开许可与工具许可分别维护；外部原文只有许可明确时才进入公开包。

## 精选知识

[精选知识仓库](https://github.com/edwardxuuu-precious/selected-knowledge) 提供两篇可直接阅读的短文，采用 CC BY 4.0。工具源码采用 MIT，两者分别维护许可。
