# 从一次 Tool Call 到稳定的 Agent Harness

## 基于 oh-my-code 全量源码与 Agent Harness 文章的工程教材

版本基线：本地仓库提交 `2a98471805f357cb3fc0da68d1b59225ab2dd9c8`（2026-08-22）

适用读者：希望从零掌握 Agent、Agent Runtime、任务编排、长任务恢复、证据闭环、多宿主适配和生产级可靠性设计的工程师。

> 阅读承诺：正文不要求读者同时打开源码。每个抽象概念都会先从一个具体失败场景引出，再给出工作机制、伪代码、项目实现映射、技术取舍、常见误区和面试表达。附录提供完整文件索引，供以后按模块反查。

---

# 导读：这本手册解决什么问题

很多 Agent 教程从 `while` 循环开始，也在 `while` 循环结束：

```text
把用户消息发给模型
如果模型要调用工具，就执行工具
把工具结果发回模型
直到模型输出最终答案
```

这个程序能演示 Tool Calling，却还不能稳定完成一个两小时、跨十个模块、需要独立验收、可能中断恢复的研发任务。真正困难的部分不是“模型会不会写代码”，而是下面这些工程问题：

1. 用户只说“改好并确保上线可用”，系统怎样把模糊目标变成可验收的结果？
2. 哪些步骤可以并行，哪些必须等待上游证据？
3. 实现者说“测试通过”时，谁来判断这是不是足以完成任务的证据？
4. 某次修复改变了共享状态后，之前的测试结论是否仍然有效？
5. IDE 关闭、上下文压缩或进程重启后，系统怎样知道从哪里继续？
6. 两个 Agent 同时修改相同文件时，怎样避免相互覆盖？
7. 不同宿主的 Hook、MCP、插件、会话 ID 和权限模型不一样，核心编排如何保持一致？
8. 系统何时应该停止，何时应该修复，何时必须向用户提问？

`oh-my-code` 的核心价值，是把这些问题从“靠 Prompt 提醒模型注意”提升为一套控制面、状态机、证据协议和宿主适配机制。它不是一个更会写代码的模型，也不是十五个人格提示词的集合。它是一层包围 Code Agent 的工程 Harness。

## 建议阅读方式

- 第 1 至 4 章建立基础概念，适合没有 Agent 框架经验的读者。
- 第 5 至 13 章解释项目最核心的运行机制。
- 第 14 至 18 章讨论并发、可靠性、安全、多宿主和测试。
- 第 19 至 21 章把知识迁移到系统设计和面试表达。
- 附录用于查文件、查角色、查 Skill、查操作和复习问题。

---

# 第一篇：先从一个会失败的 Agent 开始

# 第 1 章 LLM、Tool Calling、Agent 与 Harness

## 1.1 先不要背定义

假设用户说：

> 请在当前项目加入会话过期清理，补测试，更新文档，并确保可以提交。

一个普通 LLM 只能生成文本。它可以建议修改哪些文件，却不能读取仓库、执行测试或保存结果。

给它 Tool Calling 后，模型可以输出：

```json
{"tool": "read_file", "arguments": {"path": "src/session.ts"}}
```

外围程序执行工具，再把结果送回模型。此时模型获得了“行动能力”，但系统仍未回答：

- 模型是否可以读取任意路径？
- 删除文件是否需要批准？
- 一次失败后能重试多少次？
- “测试通过”是否足以证明用户目标完成？
- 当前对话断开后，任务状态存在哪里？

这些都不是模型参数解决的问题，而是 Harness 的职责。

## 1.2 四个概念的边界

| 概念 | 负责什么 | 不负责什么 |
|---|---|---|
| LLM | 根据上下文预测文本或结构化动作 | 不天然执行动作，不保存可靠外部状态 |
| Tool | 提供一个原子能力，如读文件、执行命令、查询定义 | 不负责决定何时调用，也不负责整体任务完成 |
| Agent | 在目标驱动下反复观察、决策、调用工具 | 单独运行时通常缺少持久化、验收和跨会话控制 |
| Harness | 约束并承载 Agent：路由、状态、权限、调度、证据、恢复、停止 | 不替代模型做语义理解，也不替代工具完成具体动作 |

一句面试表达：

> 模型负责提出下一步动作，工具负责执行原子能力，Agent 负责目标驱动的循环，而 Harness 负责让这个循环可控、可验证、可恢复、可审计。

## 1.3 最小 Agent Loop

```text
function runAgent(userGoal):
    messages = [userGoal]
    repeat:
        response = model.generate(messages, toolSchemas)
        if response is final_answer:
            return response
        if response is tool_call:
            result = executeTool(response.tool, response.arguments)
            messages.append(response)
            messages.append(result)
```

它的问题不是“写得太少”，而是所有控制都隐含在模型上下文中：

- 没有显式状态机；
- 没有任务依赖；
- 没有完成条件；
- 没有证据新鲜度；
- 没有副作用边界；
- 没有恢复点；
- 没有并发冲突控制。

## 1.4 Harness 的工程定义

可以把生产级 Harness 写成一个函数组合：

```text
Harness =
    Intent Router
  + Context Builder
  + Graph Orchestrator
  + Role/Capability Binder
  + Tool Gateway
  + State Store
  + Gate/Evidence Engine
  + Retry/Reconcile Controller
  + Permission/Safety Policy
  + Observability
  + Host Adapter
```

这不是说每一项都必须是独立微服务，而是说这些责任必须有明确归属。`oh-my-code` 选择了“声明式 Agent/Skill + Hook 激活 + CLI 生命周期 + Markdown Graph Truth + MCP 工具 + 多宿主 Adapter”的组合。

## 1.5 为什么不只写一个超长 System Prompt

长 Prompt 可以表达规则，但不能单独提供以下保证：

1. 进程重启后状态仍在。
2. 两个写操作不会竞争同一资源。
3. 已完成历史不会被后续模型改写。
4. 失败写入不会留下半更新文件。
5. 证据对应的是当前代码快照，而不是修复前快照。
6. 完成操作在条件不足时会被程序拒绝。

原则是：

> 语义判断交给模型；可机械检查的关键不变量放进 Runtime。

---

# 第 2 章 从短任务到长任务：问题是怎样出现的

## 2.1 一个贯穿全书的案例

我们用“为 Agent 服务增加会话过期清理”作为案例。用户验收目标包括：

- 过期会话会被清理；
- 活跃会话不受影响；
- 并发清理不会重复释放资源；
- 服务重启后仍能恢复清理状态；
- 单元测试与集成测试通过；
- 文档与配置示例同步；
- 代码可以提交。

这个需求至少包含需求澄清、代码探索、设计、实现、验证、Review 和文档几个边界。若让一个 Agent 在一段上下文里从头做到尾，常见失败如下。

## 2.2 上下文污染

模型最初记住的是用户目标。执行过程中，上下文逐渐加入：

- 数百行源码；
- 多轮搜索结果；
- 测试日志；
- 临时猜测；
- 已被推翻的设计；
- 修复前后的 diff；
- 用户插入的新要求。

最后模型面对的是一堆混合材料，很难判断哪些是当前事实。上下文窗口再大，也只是延迟污染，不会消除状态语义混乱。

## 2.3 自证偏差

实现者知道自己“想写成什么”，于是容易选择能证明自己方案的测试。它可能运行了构建并看到绿色，就把“能编译”说成“需求已完成”。

因此应区分：

- Producer self-check：证明实现没有明显局部错误；
- Independent verification：按验收合同验证用户可识别结果；
- Review：判断提交质量、兼容性、维护性和风险；
- Completion policy：综合 Gate、证据和状态决定是否允许结束。

## 2.4 对话摘要不是状态机

一段摘要可能写：

> 清理逻辑已实现，测试基本通过，还有一点并发问题待处理。

系统无法从中稳定判断：

- 哪个节点完成？
- 哪个 Gate 失败？
- 哪些下游结论因此失效？
- “基本通过”能否归档？
- 下一步是修复、重验还是问用户？

自然语言适合解释，结构化状态适合控制。`oh-my-code` 用 Graph Truth 保存控制事实，同时保留 Markdown 的可读性。

## 2.5 失败传播

若“设计并发模型”失败，后续实现和测试不能继续沿用原计划。线性 Todo List 只能标记某项失败，却无法表达：

```text
设计节点失败
  -> 实现节点的输入假设失效
  -> 验证节点的目标快照失效
  -> 文档节点可能仍可保留一部分
```

这就是任务图和 Reconcile 出现的原因。

---

# 第 3 章 控制面与执行面

## 3.1 为什么必须分层

控制面回答“做什么、由谁做、何时做、做到什么程度”；执行面回答“怎样读取代码、修改文件、运行命令”。把二者混在同一个 Agent 中，会让控制决策被大量实现细节淹没。

`oh-my-code` 的六层可以这样理解：

| 层 | 典型职责 | 项目落点 |
|---|---|---|
| User / Host | 接收用户输入，提供会话和工具环境 | Claude、Codex、Trae、Traex、OpenCode |
| Hook / Activation | 判断是否注入 Orchestrator 激活提醒和会话上下文 | `src/hooks/` |
| Orchestrator / Workflow | 路由、构图、Gate、Q1-Q6、收敛 | `skills/orchestrator/`、`agents/omc-orchestrator.md` |
| Specialist Agent | 分析、实现、验证、Review、写作 | `agents/omc-*.md` |
| MCP / CLI Tool | 代码证据和 Harness 生命周期操作 | `src/mcp/`、`src/lib/language/`、`src/cli/commands/harness.ts` |
| Target Adapter / Runtime | 安装、注册、宿主协议转换、状态落盘 | `src/integrations/`、`targets/`、`src/lib/core/` |

## 3.2 Graph State 与 Work State

这是文章和源码共同强调的核心区分。

Graph State 保存：

- 用户目标与非目标；
- Acceptance Contract；
- 节点、依赖、Owner；
- Gate 和 Assurance；
- 已完成事实、待执行后缀；
- 证据引用、风险、控制状态；
- 恢复和 Reconcile 所需信息。

Work State 保存：

- 当前节点读到的源码；
- 原始命令输出；
- 临时推理和候选假设；
- 大段 diff；
- 局部调试日志。

控制面只消费 Work State 的压缩结果：

```text
Status
Summary
Deliverables
Findings
Concerns
Evidence
```

## 3.3 为什么这种分法比“共享全部上下文”好

1. 主上下文不会随节点数量线性膨胀。
2. 子 Agent 可以使用 fresh context，减少旧假设干扰。
3. 恢复只依赖外部 Graph Truth，不依赖完整聊天历史。
4. 可以独立替换执行 Agent，而不改变控制协议。
5. 敏感或冗长日志无需进入长期状态。

代价是信息压缩可能丢失细节，所以返回 Envelope 必须包含证据边界和残余风险，不能只写“完成”。

---

# 第 4 章 任务重量：不是所有任务都需要 DAG

## 4.1 四条执行路径

Orchestrator 的第一步不是立即建图，而是做 Lightweight Admission：

| 路径 | 示例 | 控制成本 |
|---|---|---|
| Chat | “解释一下 MCP” | 直接回答 |
| Trivial read | “显示 package.json 的版本” | 1-2 次只读查询 |
| Direct capability lookup | “查询这个对象当前状态” | 1-2 次外部能力调用 |
| Specialist work | 代码实现、Review、诊断、跨文件分析 | Inline Specialist 或 Graph |

Specialist work 再分为：

- Specialist inline：一个验收单元、一个 Owner、无恢复价值；
- Light Graph：有少量边界和 Gate，但无需持久化；
- Persisted Graph：跨阶段、跨会话、需要审计或失败恢复。

## 4.2 为什么不能“所有请求都建图”

完整 Harness 会引入：

- 任务拆解成本；
- 状态读写成本；
- 独立验证成本；
- Gate 等待成本；
- 用户确认成本。

一个改拼写的任务若走完整 DAG，可靠性收益远小于流程成本。稳定系统不是流程最多，而是能按风险选择最小充分结构。

## 4.3 判定伪代码

```text
function admit(request):
    if noToolOrEvidenceNeeded(request):
        return CHAT

    if exactReadOnlyFact(request) and probes <= 2:
        return TRIVIAL_READ

    if boundedExternalLookup(request) and noExpertJudgment:
        return DIRECT_CAPABILITY

    boundaries = identifyAcceptanceBoundaries(request)
    if boundaries.count == 1
       and oneOwner(boundaries)
       and noRecoveryValue(request)
       and noIndependentGate(request):
        return SPECIALIST_INLINE

    if hasRecoveryValue(request) or crossesSessions(request):
        return PERSISTED_GRAPH

    return LIGHT_GRAPH
```

## 4.4 面试中的取舍表达

> 我不会把 Harness 理解成所有请求都必须经过固定工作流。好的控制面首先做 admission control：轻任务退化为直接路径，只有出现真实依赖、独立验收、多 Owner、并发或恢复价值时才升级为图。这样可靠性成本与任务风险成比例。

---

# 第二篇：把复杂目标编译成可执行图

# 第 5 章 Acceptance Horizon 与 Commitment Graph

## 5.1 为什么不能一开始就列完所有未来步骤

传统计划喜欢一次性写出：

```text
分析 -> 设计 -> 实现 -> Review -> 修复 -> 测试 -> 再修复 -> 发布
```

但“修复什么”取决于未来证据。在没有失败前创建三个修复节点，是把猜测当事实。

`oh-my-code` 区分两个视野：

- Acceptance Horizon：最终必须交付或证明的完整结果；
- Commitment Graph：当前信息下已经确定必要、可以明确 Owner 和验收的节点。

前者完整描述终点，后者只承诺现在确定要做的工作。

## 5.2 贯穿案例的 Acceptance Horizon

```text
目标结果：
  - 过期会话被清理
  - 活跃会话不被误删
  - 并发清理具备幂等性
  - 重启恢复有效
  - 文档与配置一致
  - 代码达到可提交标准

证据义务：
  - 正向：过期数据被释放
  - 负向：活跃数据保留
  - 并发：重复执行不产生双重副作用
  - 恢复：中断后从持久化状态继续
  - 提交：独立验证 + 只读 Review
```

初始 Commitment Graph 可能只有：

```text
n1 探索现有会话生命周期
n2 形成实现边界，依赖 n1
n3 实现清理逻辑，依赖 n2
```

验证节点可以在 Q5 已确定证据范围时提前物化，也可以把“何时验证、验证什么”作为 Gate obligation，等实现返回后由 Q6 再生成。

## 5.3 节点不是命令

错误拆法：

```text
n1 打开文件
n2 搜索函数
n3 修改代码
n4 运行 npm test
```

正确拆法：

```text
n1 探索会话状态所有权与生命周期
n2 实现过期清理并完成局部自检
n3 独立验证清理、并发和恢复行为
n4 Review 提交质量
```

节点应该代表可独立成功、失败、交接或验收的语义边界。读文件和跑命令只是节点内部动作。

## 5.4 反事实必要性检查

保留一个节点前问：

> 如果删除或延迟这个节点，会不会失去必要交付物、真实前置条件、唯一验收证据或恢复关键点？

若答案是否定的，节点可能只是流程装饰，应折叠或延迟。

---

# 第 6 章 DAG、依赖、冻结前缀与 Reconcile

## 6.1 结构是 DAG，执行是循环

看似矛盾的两个说法可以同时成立：

- 任一时刻的任务结构是无环 DAG；
- 整体执行是“构图 -> 派发 -> 观察 -> 重构后缀”的循环。

```text
while not complete:
    graph = deriveGraph(currentBeliefs)
    ready = selectReadyNodes(graph)
    results = dispatch(ready)
    observations = normalize(results)
    currentBeliefs = reconcile(currentBeliefs, observations)
```

每次 Reconcile 产生新的 DAG 快照，而不是在同一张图中制造循环边。

## 6.2 冻结前缀

已经派发或完成的节点代表历史事实，不应被后续计划“改写”。允许变化的是未派发的未来后缀：

- 新增节点；
- 删除尚未 ready 的节点；
- 替换未派发子树；
- 调整未来依赖；
- 更新受新证据影响的 Gate。

这和事件溯源的思想相似：历史事件不可改，当前投影可以重算。

## 6.3 失败后的 Reconcile

```text
function onNodeResult(result):
    appendAttemptEvent(result)
    moveTerminalNodeToCompleted(result)

    if result invalidatesDownstream:
        control = AWAITING_GRAPH_RECONCILE
        affected = findPendingDependents(result.nodeId)
        newSuffix = rederive(affected, result.findings)
        atomicallyReplacePendingSuffix(newSuffix)
        control = READY
```

`oh-my-code` 的 `harness_record_node_result` 会记录结果和 Attempt；若失败使下游 Pending 过期，会设置 `awaiting_graph_reconcile`。`harness_reconcile_node_result` 可把节点结果和重规划原子写入，避免两步写之间出现不一致窗口。

## 6.4 为什么不直接 retry

重试只适合“同一策略、同一输入、瞬态失败”。如果失败暴露了错误假设，直接重试只会重复消耗。

需要区分：

- transient failure：网络抖动，可有限重试；
- implementation defect：进入修复；
- contract gap：先修 Acceptance Contract；
- scope mismatch：重新确认范围；
- integration failure：先定位跨模块断点；
- blocked：等待权限、环境或用户决策；
- strategy failure：切换语义策略，而不是换一个模型继续做同一件事。

---

# 第 7 章 Orchestrator 的 Q1-Q6 决策框架

## 7.1 Q1：Outcome Framing

回答：系统最终可以诚实声称什么？

输出应包含目标、范围、非目标、验收来源和最强可证明结论。若只有“构建通过”，最终只能声称工程卫生检查通过，不能声称业务语义正确。

## 7.2 Q2：Boundary Modeling

回答：哪些语义边界不可合并？

判断依据：

- 是否是独立交付物；
- 是否有不同 Owner；
- 是否有真实因果依赖；
- 是否需要独立证据；
- 失败后是否走不同修复路径。

## 7.3 Q3：Uncertainty Frontier

回答：哪个未知量正在阻塞下一步高价值动作？

| 未知类型 | 首选动作 |
|---|---|
| 根因未知 | Debugger |
| 代码关系未知 | Explore |
| 技术决策风险高 | Architect |
| 范围和步骤未收敛 | Planner |
| 用户偏好或业务规则缺失 | 向用户提一个关键问题 |

只把“当前阻塞”的未知物化为节点。未来可能发生的未知保留为触发条件。

## 7.4 Q4：Ownership Binding

一个节点需要分清四个维度：

1. Owner：谁对结果判断负责；
2. Semantic fit：哪种 Skill/SOP 提供流程语义；
3. Capability：需要哪些工具能力；
4. Carrier：谁在 fresh context 中承载执行。

Skill 不等于 Owner，MCP Tool 也不是 Runner。Tool 是能力，Agent 是执行主体，Orchestrator 才是图的拥有者。

## 7.5 Q5：Evidence Planning

在 Producer 开始前定义证据合同：

```yaml
spec_source: user_provided
target_outcome: 过期会话安全清理
positive_checks:
  - 到期会话被删除并释放资源
negative_checks:
  - 活跃会话不被删除
  - 两次并发清理只产生一次副作用
evidence_requirements:
  - targeted_test_output
  - restart_recovery_observation
gaps: []
out_of_scope:
  - 跨地域一致性
pass_label: 在当前实现与测试范围内满足会话过期清理合同
```

证据深度按风险选择 Skip、Self-check、Targeted 或 Full。高风险、低可逆、广传播的边界需要独立证据。

## 7.6 Q6：Convergence Control

每次材料性观察到来后，Q6 判断：

1. Claim 状态怎样变化：proved、disproved、unproved、blocked、stale？
2. 接受前沿是否推进：Direct、Indirect、None？
3. 当前策略是否仍有信息增益？
4. 下一步应 continue、probe、repair、review、reverify、switch、ask、block 还是 close？

关键不是“又完成了一个节点”，而是“离可验收证据更近了吗”。

## 7.7 Evidence Distance

| 层级 | 含义 | 例子 |
|---|---|---|
| L0 Direct | 已取得用户可识别的验收证据 | 目标行为的集成测试结果 |
| L1 Enabling | 可直接产出 L0 的可执行载体 | 已可运行的测试夹具 |
| L2 Supporting | 支撑 L1 的实现或配置 | 清理服务代码、测试环境配置 |
| L3 Meta | 关于路径的计划或规范 | 设计文档、测试计划 |

做了很多 L3 文档并不意味着接近完成。Q6 用 Evidence Distance 防止“忙碌但不收敛”。

---

# 第 8 章 Agent 角色：为什么要拆，怎样避免角色泛化

## 8.1 角色不是人格

`agents/` 中的定义主要约束：

- 负责什么；
- 不负责什么；
- 如何思考；
- 何时停止；
- 可使用哪些工具；
- 输出怎样被 Orchestrator 消费。

角色拆分的目的不是模拟公司组织，而是隔离偏差、权限和上下文。

## 8.2 十五个核心角色

| 角色 | 核心职责 | 关键边界 |
|---|---|---|
| orchestrator | 路由、构图、Gate、收敛 | 不做任务面实现 |
| analyst | 把需求变成可实施、可测试输入 | 不设计方案 |
| architect | 约束分析和技术取舍 | 不实现、不做计划 |
| planner | 生成可执行步骤和依赖 | 不决定架构 |
| critic | 对计划/设计做对抗性审查 | 不重写、不实现 |
| explore | 搜索文件、符号和关系 | 不做质量判断 |
| debugger | 假设驱动地定位根因 | 不修代码 |
| executor | 在已知范围内实现 | 不扩大范围 |
| deep-executor | 沿正确性拓扑自主探索并实现 | 不重定义任务 |
| frontend-engineer | 前端状态、交互和浏览器实现 | 不修改后端契约 |
| designer | UX 状态矩阵与实现交接 | 只读，不写代码 |
| verifier | 按合同运行独立验证 | 不修代码、不补合同 |
| reviewer | 静态 Review 和提交就绪判断 | 只读，不代替验证 |
| writer | 基于已提供事实组织文档 | 不自主发现技术事实 |
| git-master | Git 历史和操作 | 不顺手改业务代码 |

## 8.3 为什么 Verifier 与 Reviewer 不能合并

Verifier 主要回答：

> 行为是否被可执行证据证明？

Reviewer 主要回答：

> 代码是否存在静态缺陷、兼容性风险、维护性问题，是否达到提交标准？

测试通过不代表没有资源泄漏、API 破坏或未覆盖分支；Review 没发现问题也不代表真实行为已运行。面向可提交代码，二者互补而非替代。

## 8.4 标准返回 Envelope

```text
Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED | FAILED
Summary: 实际完成什么
Deliverables: 文件、产物、结论
Findings: 控制面需要更新的事实
Concerns: 未解决风险
Failure: 失败证据、是否可重试、建议
```

这份 Envelope 是控制协议。没有它，Orchestrator 只能从自由文本中猜状态。

## 8.5 为什么 Subagent 必须自包含

Fresh context 能隔离污染，但会失去隐式历史。因此 Dispatch 必须包含：

```text
node_id
goal
acceptance criteria
scope / must-not
prior facts summary
target claims
evidence requirements
gate relation
output contract
```

“修一下刚才的问题”不是有效 Dispatch；它依赖主会话隐含上下文。

---

# 第 9 章 Skill：流程语义而不是第二个总指挥

## 9.1 Skill 与 Agent 的差异

- Agent 定义“谁来执行、怎样思考、输出什么”；
- Skill 定义“什么场景触发、流程怎样组织、有哪些阶段和约束”。

`oh-my-code` 当前核心 Skill 包括：

- `orchestrator`：统一 Router；
- `ralph`：完成保证 Modifier；
- `ultraqa`：测试质量收敛；
- `investigate`：假设驱动诊断路由；
- `deepinit`：项目上下文初始化；
- `deepwiki`：源码支持的本地 Wiki；
- `guide`：安装、使用和诊断；
- `worktree`：隔离工作树生命周期。

## 9.2 Semantic Assembly

若用户安装了一个“数据库迁移工作流” Skill，Orchestrator 不应把控制权完全交给它。正确过程是：

```text
读取 Skill 语义
  -> 抽取阶段、交接、Gate、失败处理、产物要求
  -> 结合当前用户目标重新编译为节点和依赖
  -> 为节点绑定 Owner、Capability、Carrier
  -> 仍由统一 Graph Truth 控制完成
```

否则多个 Skill 都可能成为“总指挥”，恢复时无法确定哪个状态权威。

## 9.3 Progressive Loading

Orchestrator 主 Skill 保持精简，只有选择某条路径后才加载相关参考：

- 构建 Graph 前加载 graph contract；
- 选择持久化后加载 Harness control 和 CLI manual；
- 使用后台事件前加载 live-control；
- 依赖宿主机制时加载 host-adaptation。

这是 Context Engineering 的一种实践：不是把所有规则永久塞进上下文，而是在决策点按需加载规范。

---

# 第三篇：Graph Truth 与 Harness Runtime

# 第 10 章 为什么用 Markdown 保存任务图

## 10.1 当前格式

一个 Harness 文件大致包含：

```markdown
# Harness Graph: session-expiry-cleanup

> Status: in_progress
> Created At: ...

## User Intent
...

## Acceptance
...

## Assurance
...

## Gates
...

## Understanding
...

## Completed
...

## Pending
...

## Attempts
...
```

活动文件位于 `.oh-my-code/harness/`，完成后进入 `completed/`。

## 10.2 为什么不是纯 JSON

Markdown 的优势：

- 人可以直接阅读和审查；
- Agent 擅长处理；
- Git diff 友好；
- 可携带解释性文字；
- 不依赖数据库服务。

但 Markdown 解析容易歧义，所以项目在可见标题旁加入隐藏元数据：

```html
<!-- omc-harness-node: {"id":"verify.cleanup","depends":["impl.cleanup"],"gate":"g.cleanup"} -->
```

可见的 `n1`、`g1` 只是显示编号；稳定逻辑 ID 才是 Mutation Key。

## 10.3 为什么不只靠标题编号

节点重排后，原来的 `n2` 可能变成 `n3`。如果 API 用显示编号更新节点，就可能改错对象。逻辑 ID 具有稳定身份，显示 ID 只服务阅读。

这是一个通用设计原则：

> 面向人的标识可以变化，面向状态机的身份必须稳定。

## 10.4 Markdown 的代价

- Parser 和 Normalizer 复杂；
- 必须防止用户文本伪造内部字段；
- 多种历史格式需要兼容；
- 大文件的局部修改困难；
- 并发写需要额外锁。

源码中 `harness.ts` 超过 7,600 行，很大一部分复杂度来自“既要人类可读，又要结构可验证，还要兼容旧格式”。如果团队更重视高吞吐和强查询，应考虑事件表或数据库；若重视本地优先、可审阅、低依赖，Markdown 是合理取舍。

---

# 第 11 章 生命周期操作与原子性

## 11.1 操作注册表

当前运行时把 Harness 操作集中在 `harness-operation-registry.ts`。重要操作包括：

| 类别 | 操作 |
|---|---|
| 创建 | create、create-linked |
| 图更新 | record-node-result、reconcile-node-result、update-graph-plan |
| 严格执行 | enable-gate-proof-v2、enable-attempt-control、claim-node-attempt(s) |
| Attempt 控制 | cancel-node-attempt、recover-node-attempt |
| 完成 | evaluate-completion、complete、fail |
| 查询 | read、list、lint |
| 会话 | bind-session、end-session、resolve-session |

同一注册表同时驱动 CLI 和兼容 MCP，避免两套入口的语义漂移。

## 11.2 为什么正常更新不用全文覆盖

`harness_update` 是低层 fallback。正常路径优先结构化操作，因为全文覆盖容易：

- 改写 Completed 历史；
- 丢失 Attempts；
- 清除隐藏元数据；
- 把非终态误写成 completed；
- 在失败时留下半成品。

结构化写入明确声明允许变化的区域。例如 `update-graph-plan` 可以替换 Pending、更新 Gate 和 Understanding，但必须保持 Completed 与 Attempts 不变。

## 11.3 原子写与锁

核心写入流程可以抽象为：

```text
function mutateHarness(path, mutation):
    lock = acquireProjectLock(path)
    try:
        before = read(path)
        parsed = validateAndNormalize(before)
        after = mutation(parsed)
        assertInvariants(before, after)
        writeTempFile(after)
        fsyncIfNeeded()
        atomicRename(temp, path)
        return readBackMetadata(path)
    finally:
        release(lock)
```

`state.ts` 提供项目锁和原子 JSON 写，`harness.ts` 还使用 Harness Mutation Lock 与 Execution Admission Lock。锁文件包含 PID/时间等 Owner 信息，并处理陈旧锁。

## 11.4 冻结历史

完成节点和 Attempt Audit 是 append-only 事实。Raw update 不能新增、删除、重排或改写它们。完成后的 Harness 是只读对象；后续修复、审计或延续必须创建 Linked Harness。

为什么这样设计：

- 防止“完成后改证据”；
- 保留失败和重试历史；
- 让恢复判断有可信基线；
- 支持审计和复盘。

---

# 第 12 章 Gate、Assurance 与完成判定

## 12.1 三个不能混淆的完成

```text
节点完成 != Gate 通过 != 整体任务完成
```

- 节点完成：某个执行单元返回终态；
- Gate 通过：一个验收边界拥有足够且新鲜的证据；
- 任务完成：所有 Pending 清空、控制状态 Ready、必须 Gate 通过、无阻塞风险，且满足当前 Assurance。

## 12.2 三种 Assurance

| 模式 | Gate 失败效果 | 使用场景 |
|---|---|---|
| advisory | 形成 Warning，可交付但不能声称无风险 | 探索性、低风险任务 |
| gated | Required Gate 未过则不能完成 | 普通生产任务 |
| ralph | Gate 未过必须有限修复并重新验证 | 必须通过、关键交付 |

Ralph 不是一个无限循环 Agent，而是 Completion Policy Modifier。

## 12.3 完成判定伪代码

```text
function evaluateCompletion(graph):
    blockers = []
    warnings = []

    if graph.pending not empty:
        blockers += PENDING_NODES

    if graph.control != READY:
        blockers += CONTROL_NOT_READY

    if graph.hasGates and assuranceMode is missingOrUnknown:
        blockers += UNKNOWN_ASSURANCE

    failing = requiredGatesWithoutPassingStatus(graph)

    if assurance == ADVISORY:
        warnings += failing
    else:
        blockers += failing

    if assurance == RALPH:
        if noExplicitGate:
            blockers += RALPH_MISSING_GATE
        if gateHasNoCurrentIndependentProof:
            blockers += RALPH_MISSING_PROOF
        if repairBudgetExhausted:
            blockers += RALPH_BUDGET_EXHAUSTED

    return verdict(
        canCompleteHarness = blockers.empty,
        canClaimComplete = blockers.empty and warnings.empty
    )
```

源码 `harness-completion-policy.ts` 就在做这类可机械验证的判断，`harness_complete` 只在策略允许时写终态并归档。

## 12.4 Gate 为什么需要 Acceptance 与 Repair

一个 Gate 不只是 `status=pass`。它还应记录：

- Acceptance：什么证据可以通过；
- Repair：失败后允许怎样修；
- 当前 Status；
- 必要时的独立性和新鲜度要求。

没有 Acceptance 的 Gate 只是一个标签，无法约束模型；没有 Repair 的 Gate 失败后容易盲目重试。

---

# 第 13 章 证据新鲜度与 Proof Projection

## 13.1 为什么旧测试会失效

时间线：

```text
T1 verifier 在 commit A 上通过 g.cleanup
T2 executor 修改共享 session store，得到 commit B
T3 系统仍拿 T1 的结果关闭 g.cleanup
```

这是典型 stale evidence。证据必须绑定：

- Gate Contract；
- 执行 Attempt；
- 代码或工作区 Snapshot；
- 风险域和 Claim；
- 必要时的外部 Receipt。

## 13.2 Contract Hash 与 Epoch

Ralph Gate 的 Proof 绑定当前合同 Hash。Assurance 全局变化提升全局 epoch；单个 Gate 的 Acceptance/Repair/Status 变化只提升该 Gate 的 epoch。

这样做比“任何变化使所有证据失效”更精确：

- 修改 `g.release` 不应让无关的 `g.docs` Proof 失效；
- 同一 Gate 改走再改回，也不能让旧 Proof 复活；
- no-op 更新不应制造无意义抖动。

## 13.3 Proof Projection

`harness-proof-projection.ts` 通过重放候选 Proof、Mutation 和 Assurance 事件，派生每个 Gate 的投影状态：

```text
PASS | FAIL | BLOCKED | CONTRADICTED | UNPROVED
```

它采用 fail-closed 原则：事件畸形、顺序非法或绑定不匹配时，不乐观地判定通过。

## 13.4 为什么不用一个布尔值

`passed: true` 无法表达：

- Proof 是否来自独立 Evaluator；
- Proof 对应哪个 Snapshot；
- 之后是否发生相关 Mutation；
- 是否存在互相矛盾的 Evaluator；
- 证据是完整证明还是部分观察。

成熟的 Agent 系统要把“结论”升级为“带来源、范围、时间和失效规则的结论”。

---

# 第四篇：并发、快照与严格执行控制

# 第 14 章 并行不是同时启动几个 Agent

## 14.1 并行安全的四个条件

两个节点没有 DAG 边，不代表可以并发。还必须满足：

1. 无因果或数据依赖；
2. Snapshot 假设兼容且冻结；
3. 无共享外部状态冲突或读后写冲突；
4. 若都是 Evaluator，重叠范围必须提供正交风险覆盖或明确独立佐证。

## 14.2 Resource Claims

严格执行合同声明资源：

```json
[
  {"kind": "path", "id": "src/session", "access": "write"},
  {"kind": "path", "id": "test/session", "access": "write"},
  {"kind": "artifact", "id": "coverage-report", "access": "exclusive"}
]
```

`harness-resource-claims.ts` 负责路径规范化、重叠判断、访问模式冲突和保守 Mutation 识别。

典型冲突：

- write 与 write 重叠；
- write 与 read/snapshot_read 重叠；
- named resource 的 exclusive 与其他访问重叠；
- 路径大小写在特定平台上等价。

## 14.3 批次边界

并行批次采用 process-as-arrive，但不是 decision-as-arrive：

```text
节点 A 先完成 -> 记录事实，但不推进 Gate
节点 B 仍运行 -> 禁止重规划、关闭或派发后继
节点 B 完成 -> 汇总 A+B
               -> 顺序无关地合并 Observation
               -> 运行一次 Q6 Boundary
               -> 写入新 Pending/Gate/Understanding
               -> Control 回到 Ready 后再继续
```

这样避免“谁先返回谁决定图”的竞态。

## 14.4 为什么最终 CI 不能和 Producer 并行

只要 Producer 仍可能修改相关 Claim 或 Snapshot，最终 CI 的结果就不是最终证据。高成本 Proof 应在稳定或冻结快照上执行。

这是工程上常被忽视的成本问题：过早跑全量测试，不仅浪费资源，还会制造“绿色但已过期”的错觉。

---

# 第 15 章 Stable Snapshot：把证据绑定到真实代码

## 15.1 Snapshot 要解决什么

Agent 说“测试通过”，必须回答“在哪一份代码上通过”。`harness-snapshot.ts` 为 Git 工作树生成稳定 Manifest 和绑定标识。

它关注：

- Git common dir、worktree root、HEAD/index；
- 指定 include scope；
- tracked、untracked、删除和特殊路径；
- 文件内容 Hash；
- 捕获期间是否发生漂移；
- symlink 和嵌套 Git 元数据风险；
- 大文件和总预算。

## 15.2 稳定捕获

```text
function captureStableSnapshot(scope):
    for attempt in 1..MAX_STABILITY_ATTEMPTS:
        before = enumerateMembershipAndIndex(scope)
        manifest = hashEveryEntry(before)
        after = enumerateMembershipAndIndex(scope)
        if before == after:
            return bind(manifest)
    throw SNAPSHOT_DRIFT
```

如果捕获时文件仍在变化，系统不应生成“稳定快照”。

## 15.3 为什么禁止把 `.oh-my-code` 放进业务 Snapshot

Harness 自己会持续写状态。如果把 `.oh-my-code` 包含在业务 Snapshot 中，每次记录结果都会改变 Snapshot，形成自引用失效。因此稳定/冻结 Snapshot 的 include 必须排除运行时状态目录，而不是靠 exclude 绕过。

## 15.4 与内容寻址的关系

Snapshot Binding 本质上是内容寻址的证据基线。它让系统能够回答：

- 两次验证是否针对同一代码状态；
- 修复后哪些 Proof 必须失效；
- 外部 Receipt 是否对应当前 Artifact；
- 并发节点是否共享兼容的只读基线。

---

# 第 16 章 Attempt Control、幂等与取消恢复

## 16.1 Node 与 Attempt 必须分开

一个语义节点可能执行多次：

```text
node: verify.cleanup
attempt-1: 环境缺依赖 -> NEEDS_CONTEXT
attempt-2: 测试失败 -> FAILED
attempt-3: 修复后通过 -> DONE
```

节点代表要完成的语义工作；Attempt 代表一次具体派发。混为一谈会丢失重试历史，也无法防止旧 Worker 回写新状态。

## 16.2 Claim 与 Token

严格模式下，Controller 原子 Claim 一个 Pending 节点并生成 Attempt Token：

```text
claim(nodeId, idempotencyKey, executionContract):
    acquire execution-admission lock
    validate graph/control/dependencies/resources/snapshot
    if exact same idempotent request already committed:
        return same attempt and token
    create active attempt
    hash token before persistence
    append proof boundary
    return opaque token
```

后续终态写入必须携带正确 Token，防止：

- 旧 Attempt 覆盖新 Attempt；
- 其他节点冒充 Owner；
- 客户端重试创建重复副作用；
- 非法跨工作树写入。

## 16.3 为什么 Token 只存 Hash

明文 Token 若写入 Harness，就会成为可重放凭证。源码使用 SHA-256 形式保存 Token Hash，调用方持有原始 Token。

## 16.4 取消不是“发了 kill 就算结束”

严格取消区分：

- request：请求宿主取消并等待可验证结束；
- termination_unverified：无法证明进程已结束，进入 quarantine/orphan；
- verified_terminated：必须由 Runtime 注册的宿主能力验证 opaque receipt；
- release_nonmutating_orphan：只有确定不会修改 Proof Subject 的孤儿 Attempt 才能释放；
- abandon_worktree：放弃旧工作树但保留隔离事实。

PID、Task ID 或“命令已发送”都不是终止证明。因为进程可能仍在运行，继续修改文件。

## 16.5 幂等的正确含义

幂等不只是“重复请求不报错”，而是：

> 相同语义请求重复到达时，返回同一个已提交结果，不重复创建 Attempt 或副作用；不同语义请求即使复用 Key，也必须拒绝。

---

# 第五篇：会话、Hook、MCP 与多宿主

# 第 17 章 Session Binding 与 Stop Closeout

## 17.1 为什么任务状态还要绑定宿主会话

Graph Truth 可以独立存在，但宿主的 Stop 事件需要知道“当前会话对应哪个 Harness”。因此项目维护：

```text
.oh-my-code/harness/state/sessions/{session_id}/session.json
```

绑定身份由 `session_id + target + cwd` 组成。Session ID 是路由标识，不是认证凭据。

## 17.2 Exact Binding

系统优先使用 exact session binding，而不是随便找一个 active Harness。否则同一仓库同时运行多个任务时，一个会话的 Stop 可能错误关闭另一个任务。

`resolveCurrentHarness` 会返回 bound、completed、stale、ambiguous、none 等语义结果。已有终态绑定不能偷偷回退到无关活动任务。

## 17.3 Stop 不是完成

宿主触发 Stop 只表示模型想结束当前轮次，不表示任务满足验收。Stop Hook 会：

1. 解析 exact binding；
2. 读取 Harness；
3. 运行 Completion Policy；
4. 若可结束，清理绑定；
5. 若不可结束，生成 continuation prompt；
6. 相同阻塞重复达到阈值后，持久化 unresolved closeout，避免无限拦截。

## 17.4 Stop Guard 为什么需要阈值

没有阈值时，模型和 Hook 可能形成死循环：

```text
模型停止 -> Hook 阻止 -> 模型再次停止 -> Hook 再阻止
```

`harness-stop-guard.ts` 按阻塞指纹记录连续次数，默认阈值为 3。达到阈值后不再假装可以自动解决，而是保存未解决事实并释放会话。

这体现了一个可靠性原则：

> Fail-closed 不等于无限阻塞。系统还需要有界升级和可观察退出。

---

# 第 18 章 Hook：轻量激活，不做隐藏编排

## 18.1 当前事件

Runtime 实现了这些 Handler：

- `user_prompt_submit`；
- `pre_tool_use`；
- `stop` / `subagent_stop`；
- `session_start`；
- `subagent_start`。

是否被具体宿主正式桥接，要看 target 配置，不能因为代码存在就说“所有宿主都支持”。

## 18.2 UserPromptSubmit

它读取全局和项目 JSONC 配置，判断 activation mode：

- auto：普通非空 Prompt 默认注入；
- manual：只在显式 `omc:`、`ralph:` 等信号时注入；
- off：跳过。

Hook 注入的是简短 Reminder，要求宿主调用 Orchestrator Skill，而不是把整套 Orchestrator Prompt 再复制一遍。

## 18.3 PreToolUse

它只对精确 Session Context 工具注入 `_host_context`，把宿主可信的 session、target、cwd 放入 Tool Input。普通 MCP 调用不能自己伪造这些字段。

这是 Trust Boundary：

```text
模型提供业务参数
宿主 Hook 注入可信身份
Session MCP 只回显已注入身份
CLI 用该身份做 exact binding
```

## 18.4 SessionStart 与 SubagentStart

- Trae 的 SessionStart 用于确保项目级 Session Context MCP 配置存在并迁移旧配置；
- SubagentStart 的实现可以查找最近的 `AGENTS.md` 并注入，但当前没有正式 target 注册，属于 dormant capability。

面试时要明确“代码已实现”和“产品链路已启用”的差别。

## 18.5 为什么 Hook 必须轻

若 Hook 同时负责构图、派发和验收，就会形成第二控制面：

- 规则隐藏在宿主事件中；
- 用户难以观察；
- 多宿主迁移困难；
- Orchestrator 与 Hook 可能给出相反决策；
- 测试需要模拟更多隐式状态。

所以 Hook 只做激活、身份注入和最小宿主适配。

---

# 第 19 章 MCP 与 CLI：能力面和控制面如何分工

## 19.1 四个 MCP 入口

| Server | 作用 | 默认公开情况 |
|---|---|---|
| omc-language | AST、Diagnostics、Runner、LSP | 正式宿主公开 |
| omc-session | 只读返回可信 Session Context | 正式宿主公开 |
| omc-harness | Harness 生命周期兼容入口 | 实现保留，正式宿主默认隐藏 |
| omc-acp | Agent/Session Bridge | 代码存在，默认未注册 |

当前正式宿主使用 CLI 执行 Harness 生命周期，而不是默认暴露 `omc-harness`。这是源码与早期文章之间的重要版本差异。

## 19.2 为什么生命周期选择 CLI

CLI 的优势：

- 入口和退出码明确；
- 可从不同宿主通过 Shell 调用；
- 容易做输入文件、路径约束和机器可读 Envelope；
- 不依赖宿主是否完整支持某个 MCP 注册模型；
- 可以与 MCP Compatibility Adapter 共享同一 Operation Registry。

MCP 仍适合代码智能和 Session Context，因为它们是模型频繁调用的结构化工具。

## 19.3 MCP Server 的基础协议

`mcp-server.ts` 实现轻量 JSON-RPC stdio Server：

```text
stdin 按行读取 JSON-RPC
  -> initialize / tools/list / tools/call
  -> schema 校验和 handler
  -> 输出 content envelope
  -> SIGINT/SIGTERM 时等待 in-flight 请求，在 grace timeout 后退出
```

生产要点：

- 协议输出只能写 stdout，日志写 stderr/文件；
- 请求 ID 必须原样关联；
- 未知工具返回标准错误；
- 关闭时要有 grace period；
- Tool Schema 是公共契约。

---

# 第 20 章 Language MCP：让代码判断建立在证据上

## 20.1 为什么不能只用全文搜索

搜索字符串无法区分：

- 函数调用与注释；
- 类型引用与同名变量；
- 导出符号与文本；
- 语法结构与格式相似的字符串。

`omc-language` 把代码能力统一成四类 Pipeline。

## 20.2 AST

AST Search 优先使用 `@ast-grep/napi`，可回退 CLI；再不支持时返回受限结果，而不是假装精确。

AST Replace 适合结构化修改，通常先 dry-run：

```text
matches = astSearch(pattern, language, path)
preview = astReplace(pattern, replacement, dryRun=true)
if preview matches intended nodes:
    astReplace(..., dryRun=false)
```

项目还防护：

- 忽略依赖、构建和缓存目录；
- 广范围操作限制；
- 语言别名和扩展名映射；
- 替换模板捕获组。

## 20.3 Diagnostics

Diagnostics 根据语言与项目根选择 Provider，例如：

- TypeScript/JavaScript；
- Go；
- Python；
- Rust；
- Java/Kotlin；
- JSON/YAML 等。

Router 负责语言推断、能力策略、Provider 候选和 fallback。统一 Result Envelope 区分 success、error、limited，不把“能力不存在”伪装成空结果。

## 20.4 LSP

LSP 子系统包含：

- Transport：JSON-RPC 帧、pending request、超时；
- Connection：进程连接和状态；
- Client：definition、references、hover、symbols、completion、diagnostics；
- Document Manager：open/change/version；
- Session：单工作区生命周期；
- Server Manager：复用、并发和关闭；
- Provisioner：检查并准备 Server；
- Workspace Root Resolver：根据语言和构建标记找根目录。

为什么这比为每种语言手写解析器好：LSP 是成熟的语义协议，可以复用编辑器生态。代价是 Server 安装、进程生命周期、工作区根推断和协议兼容更复杂。

## 20.5 Runner

Runner 用于执行小代码片段验证假设，具有最长 30 秒限制。它不应替代项目测试，也不适合执行不可信的任意代码而没有沙箱。

---

# 第六篇：多宿主适配、构建与配置

# 第 21 章 Target Provider：核心语义不应写满宿主分支

## 21.1 适配问题

Claude、Codex、Trae、Traex、OpenCode 在以下方面不同：

- Agent 定义格式；
- Skill 命名空间；
- Hook 事件和 Payload；
- MCP 配置文件；
- Plugin 安装命令；
- Session 生命周期；
- Background/Steering 能力；
- 权限和工具名。

若在 Orchestrator 中写：

```text
if host == claude ...
else if host == codex ...
```

控制面很快会被平台细节污染。

## 21.2 Provider Contract

`target-provider.ts` 抽象：

- Host facts；
- Content filter；
- Runtime capability；
- Lifecycle；
- Orchestrator Spec；
- Agent Spec；
- 支持 Surface。

`target-provider-registry.ts` 把 Host Family 的能力、Posture 和编排资产组装成 Provider。核心语义保持宿主中立，Adapter 决定怎样落地。

## 21.3 Host Posture

同一宿主不同模型或版本的能力也不同。`host-posture-runtime.ts` 根据：

- target；
- model ID/family；
- context window；
- tool、parallel、background 等能力；
- adapter observation；
- 配置 override；

生成规划 Envelope。它还会 clamp 不可能的能力，避免 Prompt 声称宿主能做实际不支持的事。

## 21.4 各宿主策略

- Claude：本地 Marketplace Plugin，包含 Agents、Skills、Hooks、MCP；
- Codex：Marketplace Plugin + 平铺 Agent TOML + Hooks Feature；
- Trae：文件系统集成，Skill/Agent/Hook 可复制或 Symlink，MCP 仅在显式路径时合并；
- Traex：同步 Runtime 后调用 Plugin Install；
- OpenCode：本地 Loader 和统一 Plugin 注入；V2 另有配置目录与事件桥；
- DSH：通过 Patch、Hooks Bridge、Agents Plugin 和 Activation Plugin 集成，当前更偏内部/实验 Surface。

## 21.5 安装必须有 Ownership Marker

Installer 不能删除同路径下不属于自己的文件。因此多个 Target 实现都维护：

- managed marker；
- provenance/state；
- symlink target 检查；
- 历史残留识别；
- 备份；
- uninstall 只清理受管资产。

这是插件生态中很重要的安全原则：安装器必须能证明“这个文件由我创建”，才能覆盖或删除。

---

# 第 22 章 Bundle Compiler：声明式资产怎样变成各宿主产物

## 22.1 为什么需要编译

Agent 与 Skill 的源文件是宿主中立的 Markdown，但不同宿主要求不同格式。项目使用构建器把公共 Orchestration 与 Host-specific 内容编译成 Target Bundle。

编译过程：

```text
读取 common + host source
  -> 校验 source ownership
  -> 防止跨 Host 引用
  -> 注入 host-specific 片段
  -> 生成 Agent/Skill/Manifest
  -> 计算 source hash、artifact hash、manifest hash
  -> 写入 dist/targets/<target>
```

## 22.2 为什么 Manifest 要同时保存 Source Hash 和 Artifact Hash

- Source Hash 证明产物来自哪组输入；
- Artifact Hash 证明当前文件没有被篡改或漂移；
- Manifest Hash 保护 Manifest 自身一致性。

Installer 在使用 Bundle 前会重新校验：

- 目标 Host 是否匹配；
- 文件路径是否安全；
- 源文件是否仍对应；
- Artifact 内容是否匹配；
- Manifest 结构和版本是否合法。

这使“构建成功”与“安装时使用了正确产物”形成闭环。

## 22.3 Agent Generator

Codex 与 Trae Generator 解析 Agent Markdown Frontmatter，再转换为宿主格式。生成器严格限制合法字段，防止把某宿主不支持的配置静默带过去。

通用经验：

> 声明式源文件应是单一事实源，各宿主产物由确定性编译生成，而不是人工维护多份近似副本。

---

# 第 23 章 配置、迁移和运行时路径

## 23.1 两层 JSONC

配置由全局和项目级组成，项目覆盖全局：

```text
~/.oh-my-code/oh-my-code.jsonc
{project}/.oh-my-code/oh-my-code.jsonc
```

对象递归合并，数组和标量覆盖。向上查找项目配置时以 repo root、`.git` 或文件系统根作为边界。

## 23.2 为什么选 JSONC

与 JSON 相比，JSONC 支持注释和尾逗号，适合人工配置。代价是不能直接使用 `JSON.parse`，更新时还要保留格式与评论。

`config.ts` 使用 `jsonc-parser` 做定点 Edit，并处理：

- 严格解析；
- 旧字段迁移；
- 注释转移；
- 备份；
- 原子写；
- 原型污染敏感路径拦截；
- 最近项目配置解析。

## 23.3 路径迁移

旧目录 `.omc` 会迁移到 `.oh-my-code`。迁移要处理：

- 目标不存在：直接移动；
- 两边都有：递归合并；
- 同名同内容：去重；
- 同名不同内容：生成 conflict path；
- 空目录清理。

不能简单 `rm -rf` 旧目录，因为里面可能有用户或第三方未识别状态。

---

# 第七篇：稳定性、安全与可观测性

# 第 24 章 Fail-Closed：未知时为什么要阻止，而不是猜

## 24.1 典型 Fail-Closed 点

- Assurance mode 不识别但存在 Gate；
- Session Binding 模糊；
- Harness 路径越界或 Symlink；
- Resource Claim 冲突；
- Snapshot 捕获漂移；
- Attempt Token 不匹配；
- 外部 Receipt 无 Validator；
- 宿主取消没有终止证明；
- Graph 引用不存在的 Gate/Node；
- 完成缺少独立当前 Proof。

## 24.2 Fail-Closed 的代价

它会降低“看起来顺滑”的成功率，增加 Blocked 和用户确认。但长任务系统更怕错误成功，而不是显式失败。

好的 Fail-Closed 返回必须包含：

- 稳定错误码；
- 哪个 Subject 被阻塞；
- 是否可重试；
- 需要补充的证据；
- 下一步动作。

只抛一句“失败”会把控制问题重新推回模型猜测。

## 24.3 路径安全

Harness、配置、Bundle、Worktree 都涉及路径。常见防护包括：

- Canonical realpath；
- 组件级 containment，而不是字符串前缀；
- 拒绝 Symlink 祖先；
- 限制相对路径；
- 单独处理大小写不敏感平台；
- 不接受 `..`、选项式 Ref 或不安全文件名；
- 写入前检查目标是否仍在允许根内。

---

# 第 25 章 可观测性：记录什么，不记录什么

## 25.1 三类记录

1. Graph Truth：用户目标、节点、Gate、当前理解；
2. Attempts Audit：每次执行尝试的 append-only 事实；
3. Runtime Logs/Metrics：调试和运行质量。

不要把它们混在一起。Graph Truth 需要紧凑；Attempts 要完整可审计；Logs 可以更细但不应进入模型长期上下文。

## 25.2 Metrics V2

`harness-metrics-v2.ts` 从 Control、Proof、Attempt 和 Boundary Observation 派生指标。指标值可以是：

```text
known(value)
unknown(reason)
```

这比缺失时默认 0 更可靠。0 代表确定没有发生，unknown 代表无法观测，两者在运营判断上完全不同。

可关注：

- 重复操作次数；
- Attempt 终态分布；
- Gate Proof 完整度；
- Boundary 收敛情况；
- 证据和控制域数据是否完整。

## 25.3 日志

Logger 分全局和项目级，支持级别和目录隔离。Hook/MCP 这类 stdio 组件尤其要避免把日志写到协议 stdout。

## 25.4 数据最小化

持久化状态不应保存：

- 完整 Prompt；
- 原始工具日志；
- 隐藏推理；
- 凭证明文；
- 大段代码 Diff；
- 与恢复无关的聊天内容。

保存“恢复所需最小事实”，既降低泄露面，也减少状态漂移。

---

# 第 26 章 测试策略：测试 Harness 不只是测函数返回

## 26.1 测试金字塔

仓库的测试分为：

- Unit：状态转换、Parser、Normalizer、策略、Adapter；
- Contract/Static Validator：Agent、Skill、Graph、Prompt 契约；
- Smoke：构建后入口和各宿主最小链路；
- E2E：安装、卸载、幂等、环境矩阵；
- Coverage Gate：Harness、Language、OpenCode、Codex 等子域阈值；
- CI Gate：构建、类型、测试、Invariant Check、Artifact Check。

## 26.2 对状态机最重要的测试

1. 合法状态转换；
2. 非法转换拒绝；
3. 拒绝后文件字节不变；
4. 重复请求幂等；
5. 并发冲突只允许一个成功；
6. 进程中断后状态可恢复；
7. 旧格式可读，新写入归一；
8. Completed/Attempts 不可篡改；
9. Proof 在相关 Mutation 后失效；
10. 完成条件缺失时必须阻止归档。

## 26.3 测试失败的不变量，而不只测试 Happy Path

例如测试 `harness_complete`，不能只测成功归档，还要测：

- Pending 非空；
- Gate 未过；
- Ralph 无独立 Proof；
- Proof Hash 过期；
- Control 等待 Reconcile；
- Archived 文件再写；
- 归档移动失败；
- Session Binding 同步。

## 26.4 为什么需要源码契约测试

Agent/Skill 是 Markdown，但它们同样是可执行配置。测试会检查：

- Frontmatter 字段；
- 命名格式；
- 必须章节；
- Router/Agent 共享语义；
- 不允许恢复已废弃入口；
- Host Bundle 覆盖；
- Prompt 中关键安全约束。

Prompt Engineering 进入生产后，Prompt 也需要 Schema、Lint、回归测试和版本化。

---

# 第八篇：当前实现的不足与演进方向

# 第 27 章 不要把提案当成现状

## 27.1 当前已经落地

- 声明式 Agents 与 Skills；
- Orchestrator Q1-Q6 规范；
- Markdown Graph Truth；
- Harness 生命周期 CLI 和兼容 MCP；
- Gate、Assurance、Ralph 完成策略；
- Proof V2、Attempt Control、Resource Claim、Snapshot；
- Session Binding 和部分宿主 Stop Closeout；
- Language MCP；
- 多宿主安装、Bundle 和诊断；
- 大量 Unit/Smoke/E2E/Contract Test。

## 27.2 当前仍有限制

- 没有独立后台 Scheduler Daemon 自动派发所有节点；
- 多数调度仍由 Orchestrator Prompt 和宿主 Agent Tool 驱动；
- Live Control 依赖宿主是否提供 Sideband 能力；
- `omc-harness` 默认隐藏，生命周期主要通过 CLI；
- 部分 Hook Handler 存在但未在所有 Target 注册；
- 跨不相关 Git Project 或机器全局资源需要外部协调器；
- Markdown 状态模型可读，但 Parser 和演进成本高；
- ACP Server 代码存在但不属于默认公开链路；
- Proposals 描述未来方向，不能作为当前产品承诺。

## 27.3 下一阶段合理演进

1. 将 Scheduler 从 Prompt 责任逐步下沉到 Runtime；
2. 增加后台队列、租约、心跳和可恢复 Worker；
3. 建立跨项目全局资源协调；
4. 让 Artifact Store 与 Graph Truth 分离；
5. 引入更系统的 Trace 和因果关联；
6. 对 Prompt/Graph 做离线 Eval 与故障注入；
7. 形成兼容迁移策略，控制 `harness.ts` 单体复杂度；
8. 提供可视化 Graph、Gate、Proof 和 Attempt Timeline。

---

# 第 28 章 如何从零设计自己的稳定 Agent Harness

## 28.1 第一阶段：先把最小 Loop 做对

```text
输入归一化
  -> 模型决策
  -> Tool Schema 校验
  -> 权限检查
  -> 工具执行
  -> 结果归一化
  -> 有界循环
```

必须有最大步数、超时、取消、错误分类和 Trace ID。

## 28.2 第二阶段：建立 Acceptance Contract

先不要急着做多 Agent。为每个任务保存：

- target outcome；
- positive/negative checks；
- evidence requirements；
- out of scope；
- pass label。

这一步能显著减少“模型说完成但用户不认可”。

## 28.3 第三阶段：角色分离

至少拆出：

- Producer；
- Verifier；
- Controller。

高风险代码再增加 Reviewer；根因不清时增加 Debugger。不要按组织架构堆角色，要按偏差、权限和证据边界拆。

## 28.4 第四阶段：引入 Graph

只有出现真实多边界时才建图。状态至少包含：

```text
nodes
dependencies
completed
pending
gates
control
attempts
```

## 28.5 第五阶段：持久化与恢复

恢复算法：

```text
load graph truth
validate schema and invariants
resolve active session/lease
mark uncertain running attempts orphaned or quarantined
check evidence freshness
derive ready frontier
resume only after control becomes ready
```

不要把“重新把聊天发给模型”当恢复。

## 28.6 第六阶段：并发与资源控制

在并发前加入：

- Stable Snapshot；
- Resource Claims；
- Idempotency Key；
- Attempt Token/Fencing；
- Batch Boundary；
- Cancel-and-Join Evidence。

## 28.7 第七阶段：多宿主与协议稳定

建立 Host Adapter，不让业务控制面感知具体 Hook JSON、插件路径和工具命名。把 Tool/CLI Schema 视作版本化公共 API。

## 28.8 第八阶段：评测和故障注入

除了成功率，还应测：

- 恢复正确率；
- 重复副作用率；
- stale proof 误通过率；
- 阻塞原因可解释率；
- 平均 Reconcile 次数；
- 无进展 Attempt Family 比例；
- Context 成本；
- 高成本 Proof 的无效运行率。

---

# 第 29 章 完整案例：会话过期清理如何跑过 Harness

## 29.1 用户输入

> 实现会话过期清理，保证并发安全和重启恢复，补测试和文档，最终达到可提交状态。

## 29.2 Admission

这是非平凡代码变更，跨会话生命周期、并发、持久化、测试、文档与提交 Review，具有恢复和审计价值，因此选择 Persisted Graph。

## 29.3 Acceptance Horizon

```text
Claim C1: 过期会话最终被清理
Claim C2: 活跃会话不被误清理
Claim C3: 重复/并发清理不产生重复副作用
Claim C4: 重启后可继续处理未完成清理
Claim C5: 配置与用户文档一致
Claim C6: 代码可提交
```

Gate：

```text
G1 lifecycle-design
G2 implementation-behavior
G3 recovery-and-concurrency
G4 documentation
G5 submit-readiness
```

## 29.4 初始 Commitment Graph

```text
n1 explore-lifecycle @explore
n2 design-boundary @architect depends n1 -> G1
n3 implement-cleanup @deep-executor depends G1
n4 update-docs @writer depends n2
```

验证和 Review 的证据义务已经写进 Gate，但具体节点在实现快照稳定后再物化。

## 29.5 创建与控制

```text
ctx = omc-session.get_context()
h = harness.create(
  user_intent,
  acceptance,
  assurance = gated,
  pending_nodes,
  gates,
  session = ctx
)
assert h.control == READY
```

若返回 `awaiting_user_confirmation`，必须通过宿主的用户提问能力等待确认，不能自行清除。

## 29.6 派发 Explore

Dispatch 包含：

- 目标：追踪 Session 的创建、续期、关闭、持久化和恢复；
- 范围：只读；
- 交付：Owner Boundary、Lifecycle、State Store、调用链；
- Done：给出带路径的完整关系图；
- 不允许：提出实现方案或修改文件。

返回后记录 Node Result，并在 Q6 判断设计边界是否已具备。

## 29.7 实现

Deep Executor 先建立 Correctness Topology：

```text
Owner: SessionStore
Lifecycle: create -> renew -> expire -> cleanup -> release
Shared state: session index + resource lease
Cleanup: failure/retry must be idempotent
Recovery: pending cleanup marker persisted before side effect
```

然后实现最小完整闭环，并运行局部测试。它的 Self-check 不是最终 Gate Proof。

## 29.8 并行与 Snapshot

实现稳定后，捕获 Snapshot S1。文档 Review 与部分只读代码 Review可以并行，但最终集成验证和任何可能修改代码的修复不能并行。

Verifier 针对 C1-C4 运行：

- 到期正向测试；
- 活跃会话负向测试；
- 并发幂等测试；
- 重启恢复测试。

Reviewer 针对 C6 检查：

- 状态所有权；
- 错误处理；
- 兼容性；
- 测试覆盖；
- 是否有范围外改动。

## 29.9 失败与精确失效

若并发测试失败，Debugger 发现 Check-then-delete 竞态。修复只修改 SessionStore 原子删除路径：

- C3 证据失效；
- C1 可能受影响，需要 targeted reverify；
- C2 若共享同一删除谓词，也标为 Unknown；
- 文档 C5 不受影响；
- Review C6 需做 repair-delta。

系统不应无差别重跑所有步骤，也不能保留明显相关的旧 Proof。

## 29.10 Closeout

只有当：

- Pending 为空；
- Control 为 Ready；
- G1-G5 通过；
- Proof 绑定当前 Gate Contract 和 Snapshot；
- 无阻塞 Concern；
- Session Binding 一致；

才调用 `harness_complete`。归档后的文件只读；后续新增需求使用 Linked Harness。

---

# 第九篇：面试表达与系统设计

# 第 30 章 高频问题与高质量回答

## 30.1 “Agent Harness 和 Agent Framework 有什么区别？”

> Agent Framework 常强调开发抽象，例如模型、工具、Memory、Chain、Graph API；Harness 更强调运行约束与可靠执行，包括准入、权限、状态、调度、证据、恢复、停止和宿主适配。二者可以重叠，但评价 Harness 时我更关注失败后能否恢复、是否防重复副作用、完成声明是否有独立证据。

## 30.2 “为什么要多 Agent？一个强模型不够吗？”

> 多 Agent 不是为了角色数量，而是为了上下文隔离、权限隔离和认知独立。实现者与验证者分离能降低自证偏差；Explore 与 Executor 分离能控制写权限；Orchestrator 不吸收 Work State，可以让长任务保持稳定。小任务仍应单 Agent 或 Inline，避免调度开销。

## 30.3 “为什么用 DAG？”

> DAG 能显式表达依赖、并行和验收边界。执行本身仍是循环：每次材料性观察后只重算未派发后缀，已派发和完成部分冻结。这样既支持动态 Replan，又保留可审计历史。

## 30.4 “如何判断 Agent 真正完成？”

> 我区分节点完成、Gate 通过和任务完成。完成策略检查 Pending、Control、Required Gates、Proof 新鲜度、独立 Evaluator、Snapshot、风险和 Repair Budget。最终完成不是模型一句话，而是 Runtime 可拒绝的状态转换。

## 30.5 “长任务怎样恢复？”

> 把目标、节点、依赖、Gate、Completed、Pending、Attempt 和控制状态外置为 Graph Truth。恢复时验证 Schema、Session/Lease、Running Attempt、Snapshot 与 Proof 新鲜度，再派生 Ready Frontier，而不是重新总结聊天记录。

## 30.6 “如何避免重复执行副作用？”

> 使用稳定 Node ID、Attempt ID、客户端 Idempotency Key、服务端确定性 Token、Fencing 和原子 Admission。相同请求返回同一已提交 Attempt；旧 Attempt 没有有效 Token 就不能写终态。外部副作用还需要业务侧幂等键或 Receipt。

## 30.7 “为什么取消需要 Join/Receipt？”

> 发送取消只是控制请求，不证明 Worker 已停止。若未确认终止就释放资源并启动新 Worker，旧 Worker 仍可能写文件或调用外部系统。严格模式必须由可信 Runtime 验证终止 Receipt，否则进入 Quarantine。

## 30.8 “Prompt 规则和代码规则如何分配？”

> 需要语义判断、动态取舍的规则放 Prompt，例如边界拆分和风险评估；可机械检查且违反后果严重的规则放 Runtime，例如状态转换、路径边界、Token、锁、Gate 完成条件、历史不可变和 Schema 校验。

## 30.9 “为什么 Markdown 而不是数据库？”

> 这个项目是本地优先 Code Agent Harness，Markdown 便于人读、Git diff 和 Agent 处理，并用隐藏逻辑 ID 保持稳定 Mutation。代价是 Parser 复杂、并发和查询能力有限。若目标是大规模多租户调度，我会用数据库/事件日志作为权威状态，把 Markdown 作为投影。

## 30.10 “这个项目最大的技术风险是什么？”

> 第一，调度语义仍较多依赖 Prompt，缺少独立 Scheduler；第二，核心 Harness 文件承担解析、兼容、渲染和状态转换，复杂度高；第三，多宿主能力不完全对称，文档容易把存在的代码误写成已启用能力；第四，跨项目和机器级资源协调仍需外部控制面。

---

# 第 31 章 面试系统设计题：设计生产级长任务 Agent

## 31.1 需求澄清

先问：

- 任务最长多久？
- 是否允许跨会话、跨进程恢复？
- 工具有哪些副作用？
- 并发规模和租户数？
- 是否需要人工审批？
- 完成标准是否机器可验证？
- 数据与日志保留要求？

## 31.2 推荐架构

```text
API / Host
  -> Admission & Auth
  -> Planner / Orchestrator
  -> Durable Graph Store
  -> Scheduler + Lease
  -> Worker / Agent Runtime
  -> Tool Gateway + Sandbox
  -> Artifact Store
  -> Evaluator / Gate Engine
  -> Event Log / Trace / Metrics
  -> Human Approval
```

## 31.3 核心数据表

```text
workflow(id, tenant, goal, status, version, created_at)
node(id, workflow_id, contract, status, owner, attempt_no)
edge(from_node, to_node)
gate(id, workflow_id, contract_hash, status)
attempt(id, node_id, lease_owner, lease_expiry, token_hash, status)
event(seq, workflow_id, type, payload, created_at)
artifact(id, workflow_id, content_hash, uri)
evidence(id, gate_id, attempt_id, snapshot_id, verdict, freshness)
approval(id, workflow_id, action, status, actor)
```

## 31.4 调度伪代码

```text
loop:
    workflow = leaseRunnableWorkflow()
    readyNodes = queryReadyNodes(workflow)
    batch = selectConflictFreeFrontier(readyNodes)

    for node in batch:
        attempt = claimWithIdempotency(node)
        enqueue(attempt)

worker(attempt):
    renewLease()
    result = runAgentInSandbox(attempt.contract)
    appendEvent(result)
    finalizeAttemptWithFenceToken()

controller(workflow):
    observations = readClosedBoundary()
    newProjection = replayEvents(observations)
    invalidateStaleEvidence(newProjection)
    reconcilePendingSuffix(newProjection)
    if completionPolicyAllows:
        complete()
```

## 31.5 一致性选择

- Graph Store：事务和乐观版本；
- Event Log：append-only，支持重放；
- Worker：at-least-once delivery；
- 副作用：业务幂等键；
- Claim：Lease + Fencing Token；
- Artifact：内容 Hash；
- Completion：单独事务和最终 Gate 校验。

## 31.6 如何回答 CAP

Agent 长任务通常优先一致的控制事实而非可用性幻觉。网络分区时，可以允许只读状态查询，但不应让两个 Controller 同时拥有同一写任务。执行面可以 at-least-once，副作用通过幂等和 Fencing 收敛。

---

# 第 32 章 复习路线

## 第一轮：建立概念

能够不看资料解释：

- LLM、Tool、Agent、Harness；
- Graph State 与 Work State；
- Node、Attempt、Gate、Proof、Snapshot；
- Orchestrator 与 Worker；
- self-check、verification、review。

## 第二轮：画出主链路

```text
Prompt
 -> Hook Activation
 -> Orchestrator Admission
 -> Q1-Q5
 -> Harness Create
 -> Session Binding
 -> Claim Attempt
 -> Specialist Execution
 -> Node Result
 -> Q6 Reconcile
 -> Gate Proof
 -> Completion Policy
 -> Archive
```

## 第三轮：讲失败路径

重点复述：

- 模糊合同；
- 失败下游失效；
- Stale Proof；
- 并发写冲突；
- 重复请求；
- Worker 取消未终止；
- Session 绑定错误；
- Stop 无限循环；
- 宿主能力不对称；
- 安装器误删用户文件。

## 第四轮：做技术取舍

对每项设计都能回答：

- 为什么需要；
- 不使用会怎样；
- 当前方案优点；
- 当前方案代价；
- 什么规模下应换方案。

---

# 结语：真正稳定的 Agent 不是更会“想”，而是更难错误地“完成”

Agent Harness 的本质不是堆更多 Prompt、角色和工具，而是把一次不确定的模型执行变成一个受控制的工程过程：

- 目标被写成可验收合同；
- 工作被拆成有真实边界的图；
- 执行与验证相互独立；
- 结果绑定 Attempt、Snapshot 和 Gate；
- 失败触发 Reconcile，而不是盲目重试；
- 并发受资源和快照约束；
- 状态可持久化、恢复和审计；
- Runtime 能拒绝虚假的完成声明；
- 宿主差异被隔离在 Adapter 中。

如果只能记住一句话：

> 模型可以提出“我做完了”，但只有 Harness 有资格根据当前状态和证据决定“是否允许完成”。

---

# 附录说明

以下附录由生成脚本基于当前提交自动构建。它们覆盖 canonical 克隆中的全部非 Git 文件；`oh-my-code-ssh` 与 canonical 克隆处于相同提交且目录内容无差异，因此不重复列出。附录用于检索和事实校验，不替代前面的递进式教学正文。

