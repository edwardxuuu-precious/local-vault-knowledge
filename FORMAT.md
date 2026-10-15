# Local Vault v1 格式与接口

## 当前正文

- local_id：独立阅读正文的稳定 ID；旧 Context Router 正文继续使用原 context_router.id。
- display_title、aliases：非保护展示字段，用于短标题与历史名称查找。
- projects：独立阅读正文的范围。已有受保护对象保留其原项目与 canonical 关联。
- created_at：保留原值。移动包另保存文件原创建时间，避免用导入时间替代原时间。
- observed_at：实际观察日期；sources 记录定位、阅读程度及可选版本。source_content_coverage 区分只读链接、片段、全文与已核对项目结果。
- 原有身份、状态、项目、权限与来源保护字段保持。
- 编辑内容 status=unverified。originalStatus 仅描述原证据版本。

一个当前问题维护一份可编辑正文。不同原对象可通过普通阅读归并引用，但原 ID、状态与证据继续独立。不同状态不会因标题或文字相似自动裁决。原始版本、SQLite 事件与签名回执位于 90_系统，不是缓存。

## 四个接口

search(query, project?, limit=5) 返回片段、ID、位置、范围、原状态、当前编辑状态、边界、未结、证据指针和相关版本。最多 20 条；完整流程用 get 展开。

get(id) 返回当前完整正文及原版本信息。重复 ID、保护字段漂移、不同当前版本竞争或 restricted 内容会拒绝使用。历史记录显式带 historical=true。

buildContext(task, workspace?, project?) 绑定项目，读取最多八个明确声明的相对真源文件并带哈希、内容、可用性和不可用原因；兼容字符串与带 path 的注册表定位。未登记项目使用通用参考、个人原则及同工作区指纹的待验证经验；后者仅用于 test_only + reversible_trial_only。未加载全部真源不声称事实已核验。

previewChange(id, baseHash, proposedRaw) 比较基础版本、保护字段、精确重复和可能重复。返回差异与 previewHash；没有 apply 或生命周期转换。

日常 CLI 的 capture-preview 接收有界正文、来源、观察日期、明确范围及可选 targetId/baseHash，返回实际正文差异、重复候选与确认哈希。capture-save 只应用用户确认的同一预览到普通阅读正文；保留原身份、创建时间与来源，保持待验证。完全重复复用；独立编辑、保护字段或范围改变须重新审阅。只有正文实质更新时保存按哈希去重的原字节，不追加规范事件或创建全库备份。

## 私人包与工作副本

归档采用 manifest.json 和 payload/ 的 tar/gzip。Manifest 包含格式版本、包内容身份、模式、相对路径、内容哈希、字节数、权限、mtime、原创建时间、正文基础版本及一致 SQLite 事件证明。

- full：完整私人存储的一个一致快照。SQLite 来自只读见证副本的 Backup API；WAL 已提交内容进入快照。
- mobile：选定正文、引用附件、基础版本与 .vault-workspace.json；role=working_copy。
- public：人工选中和确认的公开正文及许可，sourceVault=null，不带私人笔记清单或数据库。

包身份是确定内容的 SHA-256。完整性校验不等于证明包来自可信主体；导入者需明确选择预期身份与来源。

检查先读取见证过的归档副本。拒绝路径穿越、链接、特殊文件、重复成员、额外/缺少文件、坏哈希、无效 SQLite 和不受支持的格式。读取有文件数、单文件、总字节与解压比例边界，失败清理临时目录。

导入仅写新的工作副本，重复导入相同未改包保持不变。已修改副本或其他身份占用时拒绝覆盖。移动编辑按原 ID 和 baseHash 返回单端/双端差异，保护字段改变时阻止提交。

人工绑定需要完整原包、预期 ID、未修改的副本、reviewer、旧主库停止声明、外部备份目录和代码位置。本机路径通过迁移映射解析；历史引用、原签名与生命周期保持原身份，不重新签发历史授权。

## 公开确认

输入显式选中 ID、原 rawHash、公开正文、rights=original|permission|unknown 和来源 URL。许可与脱敏是人工核实项。预览记录原证据状态与范围，flags 非空不能导出。

导出需要同一预览哈希、reviewer 和确认。正文或原资料改变后原预览失效。公开包是静态派生版本；不回写私人对象的隐私级别、状态或审批。

## 增长与权限

读取不写账本、清单、队列、知识版本或备份。无变化刷新是 no-op。全量清单存在于传输包的校验元数据或临时预览中，日常正文保存关键事实与最短证据定位。

MCP 只读。整理应用限于阅读路径与非保护展示内容；活动库绑定、恢复、生命周期与公开导出留在人工 CLI。当前 Context Router 的启停开关与自动 Hook 不受本工具影响。
