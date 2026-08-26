# ByteTech 文章阅读笔记：Agent Harness 框架

> 说明：本文档是对 ByteTech 文章《如何设计一个面向复杂需求和长任务的 Agent Harness 框架》的脱敏摘要与工程笔记，不是原文逐字复制。
> 已移除或泛化个人身份、邮箱、工号、Lark/OpenID、文档 token、签名图片 URL、内部仓库 URL 与内部安装源等敏感信息。

## 元信息

- 来源：ByteTech 文章页
- 标题：如何设计一个面向复杂需求和长任务的 Agent Harness 框架
- 发布时间：2026-06-22
- 分类：基础架构
- 作者：已脱敏
- 原始链接：已脱敏，仅保留本地阅读结论

## 一句话总结

文章讨论的是面向 Code Agent 的 Agent Harness 思路：不要只依赖一个长上下文 Agent 自由发挥，而是把复杂研发任务拆成可调度、可验证、可恢复的任务图，并用外部状态保存任务进度、依赖、Gate 和节点结果。

## 文章核心结论

1. 单 Agent 能处理短任务，但在长周期、多阶段、跨模块、需要恢复的任务里容易失稳。
2. 长任务真正需要外置保存的是任务结构本身，而不是把更多历史都塞进模型上下文。
3. 应区分两类状态：
   - Graph State：用户目标、约束、任务拆解、节点依赖、Gate、进度和恢复判断。
   - Work State：代码细节、测试输出、工具调用、临时假设和局部实现过程。
4. 主控制面应该持有 Graph State；具体执行单元处理 Work State。
5. 生成、验证、审查、质疑和写作应拆成不同职责边界，避免同一上下文既生产又自证。
6. 复杂任务更适合表达成任务图，而不是线性 checklist。
7. Gate 的价值是阻断错误传播：设计没过不实现，验证没过不交付，验收不清不继续。
8. 失败后不应简单“重试一下”，而应判断哪个节点失败、哪些下游失效、是否需要 reconcile 后重新派生 Pending。

## 推荐架构分层

文章将 Agent Harness 划分为六层：

| 层次 | 职责 |
| --- | --- |
| User / Host | 承接用户输入和宿主环境差异 |
| Hook / Activation | 只做轻量激活和必要上下文注入 |
| Orchestrator / Workflow | 将用户意图转为任务图，选择流程，控制 Gate，决定恢复策略 |
| Code Agent | 由 analyst、executor、verifier、reviewer、writer 等角色处理局部任务 |
| MCP Tool | 提供代码理解、验证、任务状态读写等证据能力 |
| Target Adapter / Runtime | 隔离不同宿主的安装、Hook、MCP 注册和状态存储差异 |

## Orchestrator 的职责边界

Orchestrator 是控制面，不直接承担所有执行细节。它主要负责：

- 判断请求是普通对话、轻量读取、能力查询，还是需要进入 Harness。
- 根据目标和约束创建任务图。
- 选择合适的 Skill、Agent 或工具。
- 派发节点任务，收集结构化节点结果。
- 根据 Gate、失败、阻塞和证据不足决定继续、修复、重验、重新规划或等待用户确认。

Orchestrator 不应该保存完整代码 diff、测试长日志和每一步临时推理。这些属于执行节点的 Work State，只需要以摘要、证据、风险和结论的形式回写到 Graph State。

## Subagent 输入输出契约

文章强调 Subagent 应使用自包含任务契约，不能依赖主对话里的隐含信息。一次派发至少应包含：

- 任务目标：这次调用要完成什么。
- 验收标准：什么算完成，什么证据可以证明完成。
- 上游结论：只传必要摘要。
- 范围边界：哪些文件、模块、章节或行为不应触碰。
- Gate / Assurance：本次产出是否影响后续 Gate，失败后如何处理。

Subagent 返回也应结构化：

- Status：DONE、DONE_WITH_CONCERNS、NEEDS_CONTEXT、BLOCKED 或 FAILED。
- Summary：实际完成内容。
- Deliverables：代码、文档、结论或验证结果。
- Findings：需要更新到 Graph State 的事实。
- Concerns：未解决风险、阻塞或不确定性。

## Harness Graph Truth

文章认为自然语言总结不适合作为长任务状态机，因为它会混合事实、判断和计划，也难表达下游依赖是否失效。

Graph Truth 应保存：

- Pending：未来待执行节点。
- Completed：已完成且冻结的历史。
- Gate：阶段边界和验收卡点。
- Node Result：节点交付物、证据、发现和风险。
- Reconcile：失败、阻塞或证据不足后的重规划屏障。

这套结构让任务恢复时不依赖聊天记录，而是直接读取外部事实源，判断下一步应该继续、修复、重验、重新规划还是询问用户。

## 什么时候值得进入完整 Harness

适合进入 Harness 的任务：

- 需要调研、设计、实现、验证、文档等多个阶段。
- 改动跨模块，失败后需要判断哪些结论仍有效、哪些下游要重算。
- 需要独立验证或代码审查，不希望实现者自己验收自己。
- 可能跨会话继续，需要保留 Pending、Completed、Gate 和 Node Result。
- 团队希望把研发 SOP、评审标准或排障路径写成可复用 Skill。

不适合进入 Harness 的任务：

- 一次性问答。
- 目标明确的小范围修改。
- 已有稳定脚本能直接跑完的 runbook。

## 对当前 larkbot 项目的映射

当前 larkbot 已经具备部分 Harness 基础：

- 已有 workflow v2 schema，可保存 steps、artifacts、citations 和 progress events。
- 已有 runner，可顺序推进步骤、暂停确认、恢复、取消和重试。
- 已有状态持久化，可把 workflow 落到本地 JSON。
- 已有确认码和确认卡片通道，可承接副作用 Gate。

当前主要缺口与文章观点基本一致：

- 缺少稳定 planner：还不能把自然语言复杂目标可靠转成可恢复任务图。
- 缺少业务 worker：文档总结、会议安排、资料回顾、数据分析还没有真实 workflow adapter。
- 缺少后台 workflow queue：长任务仍依赖当前消息处理链路推进。
- 缺少 workflow 级 timeout、并发控制、artifact 文件存储和可查询 trace。
- 缺少 Graph Truth 级 reconcile：失败后还不能自动判断哪些下游步骤要作废和重新派生。

## 建议的下一步升级

1. 先实现文档总结工作流 MVP。
   - 识别 ByteTech/飞书文档链接。
   - 读取 doc/wiki 内容。
   - 生成结构化章节摘要。
   - 为关键结论绑定 citation。
   - 生成报告 draft artifact。
   - 发送前走确认 Gate。

2. 引入 planner 合同。
   - 输入：用户自然语言目标、会话上下文、可用工具、权限边界。
   - 输出：workflowType、steps、requiredInputs、riskLevel、gates、acceptanceCriteria。

3. 强化 runner。
   - step timeout。
   - workflow timeout。
   - workflow 级并发控制。
   - 失败后 reconcile 状态。
   - 对用户可读的状态查询和失败定位。

4. 引入 Subagent / Worker 结构化返回。
   - Status。
   - Summary。
   - Deliverables。
   - Findings。
   - Concerns。
   - Evidence / Citations。

5. 把 artifacts 从纯 JSON 扩展到文件型产物。
   - 报告草稿。
   - 数据分析结果。
   - 图表。
   - 会议候选方案。
   - 引用索引。

## 可借鉴到 larkbot 的设计原则

- Workflow first：复杂任务先落状态，再执行。
- Evidence first：总结、分析、验证必须带来源证据。
- Gate first：副作用、范围变化、验收不清时暂停确认。
- Runtime first：稳定规则进代码，LLM 负责理解、规划和写作。
- Recoverability first：不要把恢复能力寄托在聊天摘要里。
- Minimal path first：轻任务不要强行进入重流程，复杂任务再升级。

