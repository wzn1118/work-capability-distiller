# 对话能力编译器 V5 基础层实施说明

## 目标

本次升级把“会话解析工具”推进为“零代码工作能力蒸馏器”的编译器基础层。现有工作台、MCP、Skill 和独立 Agent 入口继续保留；新增的中间表示负责把原始会话、工具调用、文件变化、命令、产物和验证结果固定成可追溯、可复算、可评估的数据契约。

用户仍然可以走“选择会话 -> 自动理解 -> 查看建议 -> 一键生成 -> 打开能力包”的路径。IR 在后台工作，零代码用户无需接触 JSONL、路径或命令行；需要审计时，系统可以从能力步骤回到具体事件和来源文件。

## 本次已完成

### 1. Trace IR v1

文件：`session-forensics/lib/ir/trace-ir.mjs`，架构校验文件：`session-forensics/lib/ir/schemas/trace-ir.v1.schema.json`。

每个事件包含：

- `eventId`、`sessionId`、`parentEventId`、时间和参与者；
- 统一事件类型：消息、工具调用、工具结果、命令、文件变化、产物、验证、用户纠正、检查点和未知事件；
- 工具调用与工具结果的关联链接；
- 原始来源路径、记录序号、字节位置、原始哈希和事件哈希；
- 直接证据置信度与未知事件登记；
- 基于规范化内容的确定性 `fingerprint`。

这使同一输入重复分析时得到同一轨迹指纹，也让后续多会话合并可以按事件来源去重，而不依赖模型措辞。

### 2. Capability IR v1

文件：`session-forensics/lib/ir/capability-ir.mjs`，架构校验文件：`session-forensics/lib/ir/schemas/capability-ir.v1.schema.json`。

每项能力包含：

- 会话专属 `id`、版本、标题、摘要和触发条件；
- 前置条件、输入结构、步骤、输出结构、验收条件和失败恢复；
- 每个步骤的工具契约、证据引用、置信度和失败处理；
- 文件、命令、网络范围等安全边界；
- 来源会话、证据图谱指纹和评估状态；
- `static`、`contract`、`replay`、`heldout`、`canary` 五类评估状态。

没有显式候选证据的旧能力会绑定到对应 Trace 指纹，避免生成“没有证据引用”的能力步骤。

### 3. 旧解析结果兼容桥接

文件：`session-forensics/lib/ir/legacy-bridge.mjs`。

旧解析器产生的标准化时间线、能力候选和 Skill 蓝图会转换为同一个 IR 包：

```text
conversation-ir-bundle/v1
  trace: Trace IR
  capabilities: Capability IR[]
  summary: 轨迹摘要、能力数量、能力指纹
```

这一步是渐进迁移的关键：旧 CLI、MCP、报告和 UI 仍可以读取原字段，新模块则读取稳定的 IR，不需要一次性重写所有消费者。

### 4. 分析产物双写与清单登记

每次 `analyseSessionSource` 现在额外生成：

- `trace-ir.json`：完整 Trace IR；
- `capability-ir.json`：完整 `conversation-ir-bundle/v1`；
- `manifest.json`：记录两个新产物的路径、字节数、SHA-256 和 IR 摘要；
- `analysis.json`：增加 IR 摘要，保留原报告数据结构。

独立能力构建器和根能力包打包器会携带 `lib/ir` 或 `runtime/ir`，生成包可以脱离源码目录运行。

### 5. 迁移门面与多目标编译门面

新增 `lib/ir/migrations.mjs`，用于把旧事件结构、旧能力对象和旧 IR 包迁移到当前 v1 契约，并返回迁移记录。迁移过程不覆盖来源字段，旧输入仍可以保留在调用方的原始归档中。

新增三个目标编译器及统一门面：

- `lib/compilers/skill-compiler.mjs`：把 Capability IR 编译成 Skill 描述和 `SKILL.md` 内容；
- `lib/compilers/mcp-compiler.mjs`：把同一能力编译成 MCP 工具名称、输入输出 schema 和安全范围；
- `lib/compilers/agent-ui-compiler.mjs`：把同一能力编译成独立 Agent UI 所需的步骤、验收和恢复视图模型；
- `lib/compilers/compiler-facade.mjs`：统一执行 IR 迁移、能力静态门禁和多目标编译。

三种目标共享同一能力指纹，目标差异只存在于适配层，避免 Skill、MCP 和 Agent UI 各自重新解释同一段会话。

### 6. Golden corpus

新增 `session-forensics/fixtures/golden/basic-codex.jsonl` 与 `compiler-facade.test.mjs`。夹具覆盖用户请求、命令失败、补丁、文件变化、再次验证、工具调用和工具结果配对；测试验证事件进入 Trace IR 后可以统一编译到三个目标，并且旧格式迁移后的指纹可复现。

## 当前证据优先级

现阶段排序仍由确定性规则负责，模型只用于命名、摘要和表达：

1. 最新明确用户修正；
2. 后续已验证的执行步骤；
3. 后续成功结果；
4. 当前文件和 Git 证据；
5. 早期未验证内容；
6. 模型推断。

因此，旧需求与新修正冲突时，能力 IR 应保留两条来源证据，并将最新修正作为默认执行路径。

## 与附件审计方案的对应关系

| 审计建议 | 当前状态 | 落点 |
| --- | --- | --- |
| Trace IR / Capability IR | 已完成基础版 | `lib/ir/*` |
| 旧入口渐进迁移 | 已接入 | `legacy-bridge.mjs` 与分析双写 |
| 来源、哈希、证据引用 | 已完成 | Trace provenance、Capability evidenceRefs |
| schema 迁移与多目标 compiler facade | 已完成基础版 | `ir/migrations.mjs`、`compilers/*` |
| golden corpus 与输入回归 | 已完成最小基线 | `fixtures/golden/*`、`compiler-facade.test.mjs` |
| 多会话图谱与冲突归并 | 已完成基础合并、去重、冲突留痕和项目分组 | `lib/ir/multi-session-reducer.mjs`、`compiler-facade.mjs` |
| 静态校验 | 契约与结构测试已覆盖 | `ir.test.mjs`、全量回归 |
| contract/replay/heldout/canary | G0-G5 门禁已接入，执行证据由调用方传入 | `lib/evaluation/gates.mjs` |
| 多 Harness 适配器 | 已完成按名称、语义版本和 Harness 的稳定注册解析 | `lib/registry/adapter-registry.mjs` |
| 注册、版本治理、运行反馈 | 注册基础已接入，运行遥测和自动回写待接入 | `lib/registry/*`、后续 Runtime Telemetry |

## 下一阶段实施顺序

### V5.1：多会话融合

本轮已落地 `lib/ir/multi-session-reducer.mjs`：同一事件按 `provenance.rawHash` 去重，保留来源会话与轨迹指纹；同名能力合并步骤、工具和证据；版本或指纹不一致时生成冲突记录；项目归属结果会输出项目分组、会话列表、项目根目录和置信度。`compileConversationBundles` 直接消费合并后的 IR，因此 Skill、MCP 和 Agent UI 共用同一份多会话能力定义。

实现 `Normalize -> Graph -> Segment -> Atomize -> Candidate -> Reduce -> Specify` 流程：

- 按会话编号、项目根、共同文件、共同产物和时间线聚类；
- 用事件指纹和证据图去重；
- 保留每条来源事件，不把多个会话压成不可追溯的摘要；
- 产出冲突列表、最新修正列表和项目边界。

### V5.2：行为评估与发布门禁

本轮已落地 `lib/evaluation/gates.mjs`：G0 校验 IR 结构，G1 校验来源与步骤证据，G2 校验输入输出和验收契约，G3-G5 接收回放、留出任务和真实工作区灰度证据。每个门禁返回 `pass / pending / fail`、理由和证据编号，并计算 `blocked / candidate / publishable`；只有全部门禁通过的能力才允许默认执行。回放执行器、留出任务调度和灰度遥测仍由后续运行时接入。

按 G0 到 G5 建立门禁：

- G0：解析和 schema 校验；
- G1：静态引用、工具契约和安全边界；
- G2：模拟输入输出的契约测试；
- G3：原会话回放；
- G4：留出任务集验证；
- G5：真实工作区灰度执行和回滚检查。

能力包只有在对应门禁通过后，才把能力标为可默认执行；其余能力在 UI 中显示为“待验证候选”。

### V5.3：能力收件箱

建议中心展示三列独立判断：

- 蒸馏优先级：P0 到 P3；
- Agent 执行顺序：接到任务后先做什么；
- 证据置信度：对话、文件、Git、产物和验证的共同支持程度。

每条建议都必须显示“为什么、证据、处理结果、下一步”，并能打开对应事件、文件差异或产物摘要。

### V6：注册与运行反馈

本轮补齐 `lib/registry/adapter-registry.mjs` 作为注册基础：适配器按名称、语义版本、Harness 和能力标签注册，编译器可以按版本稳定解析；Codex、网页会话和其他 Harness 的具体运行适配器可以在此注册。

为能力包增加版本、兼容范围、评估报告、来源指纹和运行反馈。运行失败、用户纠正和人工验收结果回写到能力版本，而不是直接覆盖原始证据。

## 验收结果

本轮新增多会话合并、冲突留痕、项目分组、G0-G5 门禁和版本化适配器注册；全量回归通过，专项测试覆盖 IR、编译器、门禁、注册表和独立产物运行时。真实回放执行器、留出任务集、灰度运行记录和遥测属于下一阶段接入项，当前编译结果会明确标注候选、阻塞或可发布状态。

本次当前分支执行：

```text
node --test --test-reporter=spec session-forensics/*.test.mjs
50 个测试通过，0 个失败
```

覆盖范围包括 IR 确定性、会话与项目隔离、网页端会话对账、能力包生成、独立 Agent、本地命令、文件修改、MCP 检查点、失败恢复和现有工作台入口。

本说明已覆盖当前分支实际落地的基础层：多会话冲突归并、G0-G5 状态门禁、版本化注册基础、三目标编译和独立运行时依赖均已完成；回放执行器、留出集调度、灰度遥测和运行反馈回写保留为下一阶段。
