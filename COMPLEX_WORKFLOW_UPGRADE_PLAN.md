# 复杂任务工作流升级规划

## 终极目标

把当前 larkbot 从“能聊天、能临时调工具的个人助理”，升级为“能接收复杂目标、拆解计划、持续执行、可恢复、可审计、能产出交付物的工作流型 Agent”。

对标方向是 WorkBudd 一类工具，但实现策略不直接追求“多个 Agent 同时乱跑”，而是先建设一个可靠的 durable workflow runtime，再逐步把文档阅读、会议安排、资料回顾、数据分析、报告生成等能力接入。

最终目标形态：

- 用户可以说：“帮我约一下下周和 A/B/C 的评审会，找个大家都有空的时间，拉会议室，发日程。”
- 用户可以说：“帮我看这几个飞书文档，做一个带引用的总结，发到群里。”
- 用户可以说：“回顾最近这个项目的会议、文档、群聊和表格，给我一份风险分析。”
- 用户可以说：“把这个表的数据做一下分析，生成可视化和结论，整理成报告。”
- 机器人能在群里多条消息汇报进度，需要确认时暂停，确认后继续，失败后可重试或明确说明失败点。

## 当前基础

已经具备的能力：

- 状态图 Agent Runtime：`reason -> act -> guard -> observe -> converge`
- 工具体系：飞书 IM、日程、任务、邮件、文档元工具、网页、Shell/Python 沙箱
- 权限策略：主人/访客、数据分级、副作用确认、安全拒绝
- 交互确认：文本确认码 + 飞书确认/取消卡片
- 本地状态层：事件幂等、审批恢复、workflow 持久区基础版
- 记忆系统：用户记忆、群共享记忆、知识图谱、冲突治理
- 人格系统：自动人格模式、默认人格、认真严肃学术人格、可爱猫娘风格、主人确认后持久切换
  - 记忆采用 shared memory + persona-scoped memory：复杂任务事实共享，学术推理习惯、猫娘风格规则和输出结构按人格分桶
- 评估基础：Node test + 对话级 eval fixtures

## 实施状态

- W0 基线对齐：复杂任务接口设计已完成第一版。
  - 新增 `src/workflow-schema.mjs`
  - workflow schema 升级到 v2，兼容读取 v1 数据
  - 定义 artifact / citation / progress event 数据结构
  - 定义 workflow 状态转换、取消、重试语义
  - `RuntimeStateStore` 保存和加载 workflow 时会规范化为 v2
  - 已补充 `test/workflow-schema.test.mjs`
- W1 Workflow Runner MVP：基础版已完成。
  - 新增 `src/workflow-runner.mjs`
  - 新增 `src/workflow-control.mjs`
  - Runner 支持 `plan/tool/transform/verify/confirm/send` 步骤推进、progress event、artifact/citation 合并、失败重试和取消
  - workflow 确认已接入现有 `ApprovalStore` 和确认卡片/确认码通道，确认后可通过 runner 继续执行，取消会标记 workflow 为 `canceled`
  - 新增主人专属工具：`start_workflow`、`workflow_status`、`workflow_cancel`、`workflow_retry`
  - 已补充 `test/workflow-runner.test.mjs` 和 `test/workflow-tools.test.mjs`
- W1.5 Graph/Gate Control：基础版已完成。
  - 新增 `src/workflow-graph.mjs`
  - 新增 `src/workflow-completion.mjs`
  - workflow schema 兼容扩展 `gates/nodeResults/control`
  - Runner 已接入 NodeResult 追加、Gate 更新、completion evaluation 和 `awaiting_graph_reconcile` 阻断
  - `start_workflow` 支持传入基础 gates、step depends、gate ids 和 acceptance
  - 已补充 `test/workflow-graph.test.mjs`、`test/workflow-completion.test.mjs`，并扩展 runner/schema 测试
- W2 文档总结工作流 MVP：基础版已完成。
  - 新增 `src/doc-source-parser.mjs`、`src/doc-reader.mjs`、`src/artifacts.mjs`
  - 新增 `src/workflows/doc-report-gates.mjs`、`src/workflows/doc-report.mjs`
  - `doc_report` 已打通来源识别 -> 文档读取 -> 分块 citation -> 报告草稿 -> 引用检查 -> 创建飞书文档 -> 发送前确认 -> 确认后发送链接/保存
  - `start_workflow` 在 `workflow_type=doc_report` 且未显式传 steps/gates 时会自动使用 W2 默认图
  - 已补充 `test/workflow-doc-report.test.mjs`，并扩展 workflow tools 测试

核心短板：

- 还没有稳定的任务规划器，不会把复杂目标拆成可恢复步骤。
- `doc_report` 已有基础版真实 worker；会议安排、数据分析、资料回顾等业务 workflow 还未接入。
- workflow 已具备 Gate、NodeResult、reconcile barrier 和 completion policy 基础能力；除 `doc_report` 外还没有其它业务级 Gate 模板和真实 worker adapter。
- artifact / citation 已有 JSON 模型和 Runner 合并能力，但还没有文件型 artifact store 和报告生成规范。
- 长任务还没有后台队列、超时策略和跨 workflow 并发管理；取消/重试目前是基础工具能力。
- 文档总结已迁移到业务 workflow 基础版；会议、数据分析等复杂任务仍未从单轮 LLM 自主循环迁移到业务 workflow。

## 设计原则

- Workflow first：复杂任务必须先落成 workflow 状态，再执行步骤。
- Evidence first：文档、会议、数据分析类任务必须保留来源引用，不能只给无来源总结。
- Gate first：节点执行完成不等于 Gate 通过，Gate 通过也不等于 workflow 可完成，必须有独立的完成判定。
- Human gates：发消息、建日程、写文档、执行高风险命令等副作用必须等待确认。
- Deterministic executor：工具执行和状态推进尽量由代码控制，LLM 负责规划、理解和写作。
- Incremental delivery：先做一个可靠 MVP，再扩到更多任务类型。
- Local-first：继续保持无 SQLite/Redis 的本地 JSON 状态体系，除非后续明确需要迁移。
- Observable：每个 workflow 都要有 trace、step log、artifact 和失败原因。

## 目标架构

### 核心模块

- `workflow-planner`
  - 把用户自然语言目标转成结构化计划。
  - 输出 `workflowType`、`steps[]`、`requiredInputs`、`riskLevel`。

- `persona-router`
  - 在进入复杂任务规划前判断本轮应使用的回答人格。
  - 当前支持 `auto`、`daily_assistant`、`academic_serious` 与 `cute_catgirl_style`。
  - 设置为 `auto` 时，学术/数学/证明类问题可先进入学术人格做严谨分析；后续可升级为 `academic_review` / `proof_check` workflow。
  - 人格只影响推理风格和输出结构，不改变权限、安全策略或工具可用性。

- `workflow-runner`
  - 按步骤执行 workflow。
  - 管理 `pending/running/waiting_confirmation/failed/completed/canceled` 状态。
  - 负责恢复、重试、取消和进度汇报。
  - 在 W1.5 后只负责推进 dispatch-ready 的节点；遇到 `awaiting_graph_reconcile` 或未通过 Gate 时不得继续下游节点。

- `workflow-store`
  - 基于现有 `RuntimeStateStore.workflows` 扩展。
  - 保存步骤状态、artifact、citation、错误、确认 token、gates、nodeResults 和 dispatch control。

- `workflow-graph-control`
  - 管理 Gate、NodeResult、reconcile barrier 和 workflow completion policy。
  - 提供 `recordNodeResult`、`reconcileNodeResult`、`updateGraphPlan`、`evaluateCompletion` 等内部 API。
  - 只修改未来待执行部分；已完成节点结果作为审计历史，不被覆盖。

- `artifact-store`
  - 保存报告草稿、文档摘录、表格分析结果、图表输出、会议候选方案等。
  - 初期仍存 JSON；文件型产物可落 `.local/artifacts/`。

- `worker adapters`
  - `doc_worker`：读飞书文档、切块、摘要、引用。
  - `calendar_worker`：查忙闲、推荐时间、创建会议。
  - `data_worker`：读表、跑 Python 分析、生成图表/结论。
  - `writer_worker`：生成报告、群消息、飞书文档草稿。
  - `reviewer_worker`：检查遗漏、引用、风险和是否需要用户补信息。

### Workflow 数据模型

建议在现有 `src/workflow.mjs` 基础上演进：

W1.5 已作为 schema v2 的兼容扩展实现；如果后续字段语义发生破坏性变化，再提升 `schemaVersion`。

```json
{
  "workflowId": "uuid",
  "schemaVersion": 2,
  "type": "doc_report | meeting_schedule | data_analysis | material_review",
  "title": "string",
  "status": "pending | running | waiting_confirmation | failed | completed | canceled",
  "sessionKey": "string",
  "ownerId": "string",
  "userGoal": "string",
  "plan": {
    "summary": "string",
    "assumptions": [],
    "missingInputs": []
  },
  "steps": [
    {
      "id": "step_1",
      "type": "plan | tool | transform | verify | confirm | send",
      "title": "string",
      "status": "pending | running | waiting_confirmation | completed | failed | skipped",
      "depends": [],
      "gateIds": [],
      "acceptance": "string",
      "input": {},
      "output": {},
      "error": null,
      "artifactIds": [],
      "citationIds": [],
      "nodeResultIds": [],
      "startedAt": "",
      "endedAt": ""
    }
  ],
  "gates": [
    {
      "id": "gate_report_citations",
      "title": "报告引用完整性",
      "status": "pending | passed | failed | blocked",
      "acceptance": "每个关键结论至少绑定一个 citation",
      "requiredEvidence": ["citation_coverage"],
      "evidenceRefs": [],
      "passedByNodeResultId": "",
      "updatedAt": ""
    }
  ],
  "nodeResults": {
    "result_1": {
      "id": "result_1",
      "stepId": "step_1",
      "status": "DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED | FAILED | CANCELED",
      "summary": "string",
      "deliverables": [],
      "findings": [],
      "concerns": [],
      "evidence": [],
      "artifactIds": [],
      "citationIds": [],
      "gateUpdates": [],
      "completedAt": ""
    }
  },
  "control": {
    "dispatchState": "ready | awaiting_user_confirmation | awaiting_graph_reconcile",
    "reason": "",
    "confirmationConsumed": true
  },
  "artifacts": {},
  "citations": {},
  "currentStep": 0,
  "resumeToken": "string",
  "createdAt": "",
  "updatedAt": ""
}
```

## 分阶段路线

### W0 基线对齐：复杂任务接口设计

目标：不急着实现多 Agent，先把 workflow 合同、状态和验收口径定义清楚。

任务：

- 梳理现有 `src/workflow.mjs` 和 `src/state-store.mjs` 的缺口。
- 定义 workflow v2 schema。
- 定义 artifact / citation / progress event 数据结构。
- 定义工作流状态机转换规则。
- 定义取消、重试、超时、确认恢复的语义。

建议新增或修改：

- `src/workflow.mjs`
- `src/workflow-schema.mjs`
- `test/workflow-schema.test.mjs`

验收标准：

- workflow v2 能兼容读取 v1 数据。
- 每个 workflow 都能保存 steps、artifacts、citations。
- 单测覆盖状态转换、确认暂停、恢复和失败重试。

### W1 Workflow Runner MVP

目标：让机器人能创建一个真实 workflow，并按步骤推进，不再只是单轮 Agent 自主循环。

状态：基础版已完成，业务 worker 尚未接入。

落地情况：

- `src/workflow-runner.mjs` 可顺序执行 workflow steps，并在每步写入 progress event。
- `confirm` step 会暂停为 `waiting_confirmation`，生成 `resumeToken`，确认后继续执行后续步骤。
- `src/workflow-control.mjs` 将 workflow 确认适配为现有审批 action。
- `bot.mjs` 已支持 `executor: workflow` 的卡片/确认码执行与取消。
- `tools.mjs` 新增主人专属 workflow 管理工具，支持创建、查询、取消和重试。

任务：

- 新增 `workflow-runner`。
- 支持步骤类型：
  - `plan`
  - `tool`
  - `transform`
  - `verify`
  - `confirm`
  - `send`
- 接入现有确认卡片：
  - 确认后继续 workflow。
  - 取消后标记 workflow canceled。
- 群聊中输出进度消息：
  - “我先拆一下步骤”
  - “已读取 3 个材料”
  - “需要你确认是否发送”
- 加入 workflow 级别 trace。

建议新增或修改：

- `src/workflow-runner.mjs`
- `src/bot.mjs`
- `src/approval.mjs`
- `test/workflow-runner.test.mjs`

验收标准：

- 能执行一个 fake workflow：plan -> tool -> transform -> confirm -> complete。
- 进程重启后能从 `waiting_confirmation` 恢复。
- 失败步骤能记录错误并允许重试。

已覆盖测试：

- `test/workflow-runner.test.mjs`
- `test/workflow-tools.test.mjs`

### W1.5 Graph/Gate Control

目标：在接入真实业务 workflow 前，把线性 runner 升级为具备 Gate、NodeResult、reconcile 和 completion policy 的可靠控制面。

状态：基础版已完成，已经接入 runner 和 `start_workflow` 工具入口。

落地情况：

- `src/workflow-schema.mjs` 已兼容扩展 `gates/nodeResults/control`。
- `src/workflow-graph.mjs` 已实现 NodeResult 追加、Gate 更新、reconcile barrier 和 graph plan 更新。
- `src/workflow-completion.mjs` 已实现 completion evaluation，Gate 未通过、缺 evidence、等待确认或需要 reconcile 时禁止完成。
- `src/workflow-runner.mjs` 已接入 NodeResult/Gate 控制，`awaiting_graph_reconcile` 时不继续执行下游步骤。
- `start_workflow` 已支持基础 gates、step depends、gate ids 和 acceptance。

设计背景：

- 复杂任务里“步骤跑完”不等于“用户目标完成”。
- 文档总结、资料回顾、数据分析这类任务必须能证明引用、证据、风险检查和外发确认都满足要求。
- 失败或证据不足时，系统不能只把当前 step 标记 failed；还要判断哪些下游步骤已经失效，是否需要重新规划、补证据、等待用户补信息或停止。

核心概念：

- `Gate`：用户可理解的验收关口，例如“文档都已读取”“报告每个关键结论都有引用”“发送前已获得确认”。
- `NodeResult`：每个执行节点的结构化返回，不直接等同于 step output；用于审计、reconcile 和 completion evaluation。
- `Control`：workflow 是否允许继续 dispatch 的状态，至少包括 `ready`、`awaiting_user_confirmation`、`awaiting_graph_reconcile`。
- `Reconcile`：在节点返回后，根据结果、证据和 Gate 状态重算未来待执行部分，只允许改 pending/future，不覆盖已完成结果。
- `CompletionPolicy`：统一判断 workflow 是否能声明完成，禁止在 Gate 未通过、证据缺失、仍需确认或仍需 reconcile 时完成。

NodeResult 合同：

```json
{
  "id": "result_uuid",
  "stepId": "read_docs",
  "status": "DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED | FAILED | CANCELED",
  "summary": "读取 3 个文档，1 个文档失败",
  "deliverables": ["artifact:doc_chunks"],
  "findings": ["doc_a 涉及上线风险", "doc_b 缺少负责人"],
  "concerns": ["doc_c 无权限读取"],
  "evidence": ["citation:doc_a_p3", "citation:doc_b_p1"],
  "artifactIds": ["artifact_1"],
  "citationIds": ["citation_1"],
  "gateUpdates": [
    {
      "gateId": "gate_docs_read",
      "status": "passed",
      "evidenceRefs": ["artifact_1", "citation_1"]
    }
  ],
  "requestedContext": [],
  "completedAt": "iso"
}
```

Gate 设计：

- 每个 workflow 类型应定义最小 Gate 集合。
- Gate 必须有 `id/title/status/acceptance/requiredEvidence/evidenceRefs`。
- Gate 状态只能由 runner/reconcile 代码更新，不能让 LLM 在自然语言里自行宣布通过。
- 对报告型任务，默认 Gate 至少包括：
  - 输入来源已识别。
  - 来源读取完成或失败被显式记录。
  - 关键结论有 citation。
  - 报告草稿已生成。
  - 外发或写入前已确认。

Reconcile 规则：

- `recordNodeResult`：追加 NodeResult，更新 step 的 `nodeResultIds`，记录 artifact/citation/evidence。
- `reconcileNodeResult`：根据 NodeResult 更新 gates、pending steps、control 和 progress event。
- 如果 NodeResult 为 `FAILED/BLOCKED/NEEDS_CONTEXT`，且存在依赖它的后续步骤，则设置 `control.dispatchState = "awaiting_graph_reconcile"`。
- `awaiting_graph_reconcile` 未清除前，runner 不得继续下游 dispatch。
- 已完成的 NodeResult 不可覆盖；修复、补证据或重跑应生成新的 NodeResult，并保留原失败记录。

完成判定：

- `evaluateWorkflowCompletion(workflow)` 返回：
  - `canClaimComplete`
  - `canCompleteWorkflow`
  - `blockers[]`
  - `warnings[]`
  - `nextAction`
- 阻塞条件：
  - 仍有 pending/running/waiting_confirmation 步骤。
  - 存在 `awaiting_user_confirmation` 或 `awaiting_graph_reconcile`。
  - 必需 Gate 未通过。
  - 报告型 Gate 缺 citation/evidence。
  - 仍存在 BLOCKED/FAILED 且未被后续 NodeResult 或用户确认处理的关键节点。

建议新增或修改：

- `src/workflow-schema.mjs`
- `src/workflow-graph.mjs`
- `src/workflow-completion.mjs`
- `src/workflow-runner.mjs`
- `test/workflow-graph.test.mjs`
- `test/workflow-completion.test.mjs`
- `test/workflow-runner.test.mjs`

验收标准：

- 能创建带 gates 的 fake workflow。
- 一个 step 返回 NodeResult 后，结果会追加到 `nodeResults`，不会覆盖历史。
- Gate 未通过时，workflow 不能标记 completed。
- `awaiting_graph_reconcile` 时 runner 不会继续执行下游步骤。
- 失败节点的下游 pending steps 会被识别为 stale，并要求重新规划或人工处理。
- 报告型 workflow 缺 citation 时 completion evaluation 返回 blocker。

### W2 文档总结工作流 MVP

状态：基础版已完成。当前版本已经可作为第一条真实复杂任务业务链路使用，但还不是最终形态；后台队列、文件型 artifact store、更强 planner 和跨任务并发治理仍属于后续 W7/W8 工作。

目标：第一个真正可用的复杂任务能力。用户给若干飞书文档链接，机器人读取、总结、带引用生成报告。

用户示例：

> 帮我看这三个文档，整理一份重点总结和风险列表，发给我确认。

执行形态：

```text
extract_sources
  -> read_documents
  -> chunk_documents
  -> draft_report
  -> verify_citations
  -> create_report_document
  -> confirm_delivery
  -> send_or_save
```

默认 Gate：

- `gate_sources_identified`
  - 验收：至少识别到一个可读取来源，或明确返回 `NEEDS_CONTEXT` 要求用户补链接。
  - 证据：来源列表 artifact。
- `gate_documents_read`
  - 验收：每个来源都读取成功，或读取失败被记录为 citation/error artifact。
  - 证据：doc content/chunk artifact、读取失败原因。
- `gate_report_citations`
  - 验收：报告中每个关键结论至少绑定一个 citation。
  - 证据：citation coverage report。
- `gate_report_draft_ready`
  - 验收：已生成可发给用户确认的报告草稿。
  - 证据：report/draft artifact。
- `gate_report_document_created`
  - 验收：报告草稿已创建为飞书文档，并记录可访问 URL。
  - 证据：report_document artifact。
- `gate_delivery_confirmed`
  - 验收：外发群消息或发送飞书文档链接前获得主人确认。
  - 证据：confirm step NodeResult。

任务：

- 文档链接识别 worker：
  - docx/wiki token 提取。
  - ByteTech 文章链接中如包含 `lark_doc_url` / `lark_doc_token`，先转换成飞书文档来源。
  - 同一消息里多个链接识别。
  - 无链接时返回 `NEEDS_CONTEXT`，并设置 `gate_sources_identified=blocked`。
- 文档读取 worker：
  - 优先复用 lark-doc / run_lark_cli。
  - 只读命令不得触发写确认；缺 scope/权限时记录阻塞原因。
  - 读取失败时记录 citation error，不把失败源静默丢弃。
- 文档分块 worker：
  - 按标题/段落切块。
  - 每块保留 sourceId、标题、位置和原始短 quote。
  - chunk artifact 不保存超长全文，只保存必要摘录和索引。
- 报告合成 worker：
  - 总结
  - 关键结论
  - 风险/待办
  - 引用来源
  - 输出 report draft artifact。
- 引用审查 worker：
  - 检查每个关键结论是否有 citation。
  - 引用缺失时返回 `DONE_WITH_CONCERNS` 或 `FAILED`，并触发 `awaiting_graph_reconcile`。
- 确认发送 worker：
  - 确认前生成飞书文档，并在确认卡片中展示文档 URL。
  - 用户确认后把飞书文档链接发到群；没有发送目标时保留为 workflow artifact。

NodeResult 要求：

- `extract_sources`：
  - `DONE`：输出 `artifact:doc_sources`，通过 `gate_sources_identified`。
  - `NEEDS_CONTEXT`：说明缺少链接或来源范围，阻塞后续读取。
- `read_documents`：
  - `DONE`：输出 `artifact:doc_contents` / `artifact:doc_chunks_raw`，通过 `gate_documents_read`。
  - `DONE_WITH_CONCERNS`：部分来源失败，但失败被记录，可继续生成部分报告。
  - `BLOCKED`：核心来源无权限或认证缺失，等待用户授权。
- `draft_report`：
  - `DONE`：输出 `artifact:report_draft`。
  - `FAILED`：写作失败或输入 chunks 不足，触发 reconcile。
- `verify_citations`：
  - `DONE`：通过 `gate_report_citations` 和 `gate_report_draft_ready`。
  - `FAILED`：列出缺 citation 的 claim，阻止完成。
- `create_report_document`：
  - `DONE`：输出 `artifact:report_document`，通过 `gate_report_document_created`。
  - `BLOCKED`：飞书文档创建失败或缺少授权，阻止发送确认。
- `confirm_delivery`：
  - `DONE`：通过 `gate_delivery_confirmed`。
  - `CANCELED`：workflow 标记 canceled，不继续外发。

建议新增或修改：

- `src/workflows/doc-report.mjs`
- `src/workflows/doc-report-gates.mjs`
- `src/doc-source-parser.mjs`
- `src/doc-reader.mjs`
- `src/artifacts.mjs`
- `test/workflow-doc-report.test.mjs`
- `test/fixtures/workflows/doc-report.json`

已落地：

- `src/doc-source-parser.mjs`
  - 解析飞书 doc/wiki URL、裸 `doxcn/doccn/docxcn` token、ByteTech 链接中的 hash 或 doc token。
  - 同一请求中多个来源会去重并生成稳定 source id。
- `src/doc-reader.mjs`
  - 飞书 doc/wiki 默认通过 lark-cli 只读命令读取，输出上限提升到报告工作流专用级别。
  - Web 来源支持公网只读读取，带基础 SSRF 防护。
  - 测试可注入 fake reader，避免依赖真实飞书环境。
- `src/workflows/doc-report-gates.mjs`
  - 定义 W2 默认步骤和六个 Gate。
- `src/workflows/doc-report.mjs`
  - 实现 `extract_sources/read_documents/chunk_documents/draft_report/verify_citations/create_report_document/send_or_save` handler。
  - 报告生成默认先尝试 LLM 长报告 prompt；输出过短或缺引用时回退到抽取式带引用报告。
  - `create_report_document` 使用 `docs +create --doc-format markdown --content -` 创建飞书文档。
  - 发送前必须停在 `confirm_delivery`，确认后才发送飞书文档链接。
- `src/workflow-control.mjs`
  - `doc_report` 默认自动挂载 W2 步骤、Gate 和 handler。
  - workflow status 展示步骤、Gate 和最近进度。
- `src/tools.mjs`
  - `start_workflow` 支持 `doc_report` 默认图和 `target_chars`。
  - 当前会话会作为默认发送目标；没有目标时保存为 artifact。

当前限制：

- 文档读取仍依赖本地 `lark-cli` 对应域命令和授权。
- 报告 artifact 目前仍存储在 JSON 状态里，未切换到文件型 artifact store。
- `doc_report` 可以作为业务闭环执行，但还没有后台 worker 队列；仍由当前请求/确认回调推进。
- ByteTech 页面如果没有可解析的飞书 token，会按公网网页读取；需要登录态的网页内容可能读取失败或只读到登录页。

验收标准：

- 使用 fake doc tools 可完整跑完。
- 报告中每个关键结论至少带一个 citation。
- 文档读取失败不会导致整个 workflow 静默失败。
- Gate 未通过时不得标记 workflow completed。
- 确认发送前必须停在 `waiting_confirmation`；取消后不得继续发送。
- 缺权限、缺链接、缺 citation 必须落为 NodeResult 和 blocker，可由 `workflow_status` 查询。

### W3 会议安排工作流

目标：支持“帮我约会议”。

用户示例：

> 帮我约下周和 A/B/C 的评审会，30 分钟，尽量下午，拉会议室。

任务：

- 解析会议需求：
  - 主题
  - 参会人
  - 时间范围
  - 时长
  - 会议室偏好
- 解析参会人：
  - 姓名/邮箱 -> open_id。
  - 同名时要求澄清。
- 查忙闲：
  - calendar freebusy / agenda。
- 推荐候选：
  - 给 2-3 个时间方案。
- 确认创建：
  - 用户确认某个方案后创建日程。
  - 可选预定会议室。

建议新增或修改：

- `src/workflows/meeting-schedule.mjs`
- `test/workflow-meeting-schedule.test.mjs`

验收标准：

- 不确定参会人时不会猜。
- 创建日程前必须展示主题、时间、参会人和会议室。
- 确认后才能调用写操作。

### W4 资料回顾与项目分析工作流

目标：支持“回顾最近材料，给我一份分析”。

用户示例：

> 回顾最近两周这个项目的群聊、文档和会议纪要，分析一下当前风险。

任务：

- 来源发现：
  - 群聊上下文
  - 长期记忆
  - 飞书文档
  - 会议纪要/妙记
  - 邮件/任务
- 检索策略：
  - 关键词 + 图谱实体 + 时间范围。
  - 记录为什么选中这些材料。
- 证据汇总：
  - 摘要
  - 冲突点
  - 风险
  - 未确认假设
- 产出分析报告：
  - 带引用
  - 可追溯
  - 明确缺口

建议新增或修改：

- `src/workflows/material-review.mjs`
- `src/source-discovery.mjs`
- `test/workflow-material-review.test.mjs`

验收标准：

- 能说明使用了哪些来源。
- 能明确“没找到证据”的结论。
- 不把记忆中的冲突/废弃事实当作证据。

### W5 数据分析与可视化工作流

目标：支持“读表 -> 分析 -> 生成图表 -> 报告”。

用户示例：

> 帮我分析这个表，看看最近一周各团队问题分布，画个图并总结。

任务：

- 支持输入：
  - 飞书表格链接
  - CSV/Excel 文件
  - Base 数据
- 数据读取：
  - 表结构识别
  - 字段类型推断
  - 行数/缺失值检查
- 分析执行：
  - Python 沙箱运行分析代码。
  - 生成统计结果。
- 可视化：
  - 初期输出 markdown 表格和文本图表。
  - 后续生成图片并上传/发送。
- 报告：
  - 数据口径
  - 核心发现
  - 图表
  - 异常/限制

建议新增或修改：

- `src/workflows/data-analysis.mjs`
- `src/data-profile.mjs`
- `src/chart-artifact.mjs`
- `test/workflow-data-analysis.test.mjs`

验收标准：

- 分析前报告数据规模和字段。
- Python 代码必须在沙箱运行。
- 图表和结论必须与数据口径一致。

### W6 Multi-Agent 编排层

目标：当单一 workflow runner 稳定后，引入多角色 Agent，但保持代码级调度和状态落盘。

推荐角色：

- Planner Agent：拆计划。
- Research Agent：找材料、读文档、检索来源。
- Tool Agent：执行工具，不做最终判断。
- Writer Agent：组织报告。
- Reviewer Agent：检查遗漏、引用和风险。
- Safety Agent：检查权限、副作用和外发风险。

关键约束：

- 每个 Agent 只能读 workflow state 和分配给自己的 artifact。
- 每次 Agent 输出必须是结构化 JSON。
- Agent 不能直接执行副作用工具，只能申请 runner 执行。
- 所有中间结果落盘。

建议新增或修改：

- `src/workflow-agents.mjs`
- `src/workflow-prompts.mjs`
- `test/workflow-agents.test.mjs`

验收标准：

- 同一任务可用 fake LLM 稳定复现。
- Reviewer 可以发现缺 citation / 缺输入 / 高风险发送。
- 多 Agent 不绕过现有权限策略。

### W7 后台长任务与运维能力

目标：复杂任务不再依赖单条消息同步完成。

任务：

- 后台任务队列：
  - 每个 workflow session 串行。
  - 不同 workflow 可并发，受全局限制。
- 用户控制：
  - 查询状态
  - 取消任务
  - 重试失败步骤
  - 展示最近 workflows
- 超时策略：
  - step timeout
  - workflow timeout
  - external tool retry
- 管理命令：
  - 查看 pending approvals
  - 查看 workflow trace
  - 清理过期 artifact

建议新增或修改：

- `src/workflow-queue.mjs`
- `src/admin-tools.mjs`
- `test/workflow-queue.test.mjs`

验收标准：

- 长任务不会阻塞消息消费。
- 取消后不会继续执行副作用步骤。
- 过期 artifact 可清理。

## 推荐实施顺序

1. W0：workflow v2 schema 和 artifact/citation 设计。（已完成）
2. W1：workflow-runner MVP，打通状态推进和确认恢复。（基础版已完成）
3. W1.5：Graph/Gate Control，补齐 gates、nodeResult、reconcile 和完成判定。（基础版已完成）
4. W2：文档总结工作流 MVP。（基础版已完成）
5. W7：后台队列和管理能力。（建议下一步，解决长任务不阻塞当前消息的问题）
6. W3：会议安排工作流。
7. W5：数据分析工作流。
8. W4：资料回顾工作流。
9. W6：Multi-Agent 编排层。
10. W8：更强 planner、文件型 artifact store 和运维面板。

W2 已完成基础版后，建议优先推进 W7 的原因：

- `doc_report` 已经能证明 citation、artifact、Gate 和确认发送闭环可运行。
- 真正的长任务体验还依赖后台队列、step timeout、workflow timeout 和任务查询能力增强。
- 后续会议安排、资料回顾、数据分析可以复用 W2 的报告生成和引用审查模式。

## 第一阶段 MVP 任务拆解

### MVP-1 Workflow v2 schema

- 扩展 `src/workflow.mjs`。
- 添加 `artifacts/citations/userGoal/plan` 字段。
- 保持 v1 数据兼容。
- 添加 schema 单测。

### MVP-2 Runner 执行器

- 新增 `src/workflow-runner.mjs`。
- 支持 fake steps。
- 接入 `RuntimeStateStore`。
- 支持 `waiting_confirmation` 恢复。

状态：已完成基础版，并已通过主人专属 workflow 工具接入 Agent 工具体系。

### MVP-2.5 Gate 与 NodeResult 控制面

- 扩展 workflow schema，加入 `gates/nodeResults/control`。
- 实现 NodeResult 追加写入和 step 结果关联。
- 实现 Gate 更新、completion evaluation 和 reconcile barrier。
- runner 在 Gate 未通过或 `awaiting_graph_reconcile` 时停止下游 dispatch。

状态：已完成基础版，完整测试通过。

### MVP-3 文档链接识别与读取

- 从消息中提取 doc/wiki URL。
- 通过 lark-doc / run_lark_cli 读取内容。
- 读取结果保存为 artifact。
- 输出 `artifact:doc_sources`、`artifact:doc_contents` 和读取失败 NodeResult。
- 通过 `gate_sources_identified`、`gate_documents_read` 或返回 `NEEDS_CONTEXT/BLOCKED`。

### MVP-4 文档总结与引用

- 分块摘要。
- 每条结论绑定 citation。
- 生成报告草稿 artifact。
- 输出 citation coverage artifact。
- 通过 `gate_report_citations` 和 `gate_report_draft_ready`。

### MVP-5 确认与发送

- 把报告草稿创建为飞书文档。
- 确认卡片展示飞书文档链接和草稿预览。
- 用户确认后发送飞书文档链接到当前会话。
- 取消后 workflow 标记 canceled。
- 通过 `gate_delivery_confirmed` 后才允许执行 `send_or_save`。

## Eval 与测试策略

- 单元测试：
  - workflow schema
  - workflow graph / gate
  - nodeResult append-only
  - completion evaluation
  - state transition
  - artifact/citation
  - runner step handling

- 集成测试：
  - fake doc read -> summarize -> confirm -> send
  - failed doc read -> partial report
  - missing input -> ask clarification

- 对话级 eval：
  - “帮我总结这些文档”
  - “帮我约会议”
  - “帮我分析这个表”
  - “取消刚才任务”
  - “继续刚才任务”

## 风险与控制

- 风险：复杂任务执行时间长，用户以为机器人卡住。
  - 控制：每个阶段主动发进度消息。

- 风险：LLM 计划不稳定。
  - 控制：计划输出 JSON schema 校验，失败则重新规划或降级澄清。

- 风险：引用缺失导致报告不可审计。
  - 控制：Reviewer 阶段强制检查 citation。

- 风险：副作用步骤被自动执行。
  - 控制：runner 层强制确认，不信任 planner。

- 风险：多 Agent 增加复杂度但不提高可靠性。
  - 控制：先做单 runner + worker adapters，多 Agent 放到 W6。

- 风险：上下文和 artifact 越积越多。
  - 控制：artifact TTL、摘要压缩、引用索引。

## 完成标准

当以下能力稳定后，可以认为复杂任务工作流第一阶段完成：

- 至少一种真实复杂任务可端到端完成。
- workflow 可重启恢复。
- 所有副作用步骤都有确认。
- 报告型任务带 citation。
- 失败可定位到具体 step。
- 用户能查询、取消、继续任务。
- 有对应单测和对话级 eval。
