# 确认后保存

把一批建议写入临时 JSON 数组；最多五项，超过时分批继续原范围。正文以简短中文标题开头，至少有“结论与用法”和“适用边界”，空的未结事项省略。

必填：title、kind（research 或 experience）、projects（已登记项目 ID；通用研究可用 *）、body、observedAt（实际观察日期）、sources。

未登记项目提供 workspacePath（当前绝对项目根目录）和空的 projects；工具只保存匿名工作区指纹，后续只在该工作区以可逆试用方式调用。更新该条目时也提供相同 workspacePath。

sources 每项包含 ref 和 readScope。link_only 表示只保存链接；excerpt 表示已读片段；full 表示已读全文；project_result 表示已核对项目结果。有稳定版本或内容哈希时增加 version 或 contentHash。未知保持未知，不用模型建议充当已观察结果。

新增可指定 path，限 30_知识与经验 的普通正文。更新提供 targetId、baseHash（get 返回的 rawHash），保留原创建时间、身份、状态与范围。相同正文的新来源合入原条目；已有同题不同正文时先准备更新，不新建副本。经验保留原项目范围，跨项目使用仍须核对边界。

运行：

~~~bash
node <skill目录>/scripts/knowledge.mjs capture-preview --file <临时建议.json>
node <skill目录>/scripts/knowledge.mjs capture-save --preview <临时完整预览.json> --expected-preview-hash <已确认哈希> --confirm
~~~

先把完整 capture-preview 输出保存到临时文件，向用户展示关键正文、差异、来源、范围和重复候选。实际用户确认同一批次后才执行第二条；未确认只留对话建议，不写 Vault。预览与当前版本不一致时保留双方，重新展示具体差异。

保存后 get 回读实际正文；确有变化再 refresh 导航。确认内容、ID、范围和证据定位一致即可退出，清理本轮临时输入。不生成 task log、Router 收尾事件或全库备份。原正文只有实质变化时保留按哈希去重的原字节，作为审计资料，不参加默认检索。
