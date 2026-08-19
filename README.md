# 零代码工作能力蒸馏器

[![CI](https://github.com/wzn1118/work-capability-distiller/actions/workflows/ci.yml/badge.svg)](https://github.com/wzn1118/work-capability-distiller/actions/workflows/ci.yml)
[![Node.js 22](https://img.shields.io/badge/Node.js-22-2f7d32)](https://nodejs.org/)
[![Windows x64](https://img.shields.io/badge/Windows-x64-1674d1)](https://github.com/wzn1118/work-capability-distiller/releases/latest)

> 把一次认真完成的工作，酿成下一次可以直接使用的能力。

聊天记录里经常藏着最值钱的部分：用户最后一次纠正、真正跑通的命令、被改过的文件、失败后换掉的方案、最终交付物，以及那句很朴素的“这次终于对了”。

零代码工作能力蒸馏器会把这些散落的信息重新拼起来。它读取一条或多条工作会话，按需理解相关项目和文件，连接工具调用、Git 差异、生成产物与验证结果，再把成功路径编译成可以安装和执行的能力包。

能力包可以包含：

- 可安装的 **Skill**；
- 可被其他客户端调用的 **MCP 服务**；
- 能读文件、改文件、执行命令和验证结果的 **独立 Agent**；
- 根据能力特性生成的 **独立中文 UI**；
- P0-P3 优先级、证据清单、任务目录和完整使用说明。

它像一个耐心的工作考古队：会话是现场记录，工具调用是脚印，Git 是地层，产物是出土文物，测试结果负责回答“这件东西到底能不能用”。

## 30 秒看懂

```text
选择本机或网页会话
  -> 系统理解目标、最新修正和真实产出
  -> 按需发现相关项目与文件
  -> 建立会话、工具、文件、Git、产物和验证证据图
  -> 给出 P0-P3 蒸馏建议
  -> 一键生成 Skill、MCP、独立 Agent 和专属 UI
  -> 打开 Agent，继续完成真实本地任务
```

适合这些时刻：

- 你刚和 AI 磨了几十轮，终于做出一套稳定流程；
- 团队里有人掌握关键操作，但经验全在聊天和临场判断中；
- 同类报告、分析、修复或文件加工任务总要从头解释；
- 想把多段会话组合成一项可复用能力；
- 想让另一台 Windows 电脑直接安装并继续使用。

## 立即使用

### Windows 一键安装

1. 打开 [最新发布页](https://github.com/wzn1118/work-capability-distiller/releases/latest)。
2. 下载名称以 `-setup.exe` 结尾的 Windows x64 安装器。
3. 双击安装器。
4. 等待自检、安装和桌面入口创建完成。
5. 浏览器会自动打开主工作台。

安装器自带 Node.js 运行环境，不要求新电脑提前安装 Node.js、npm 或 Git。Git 缺失时，与 Git 有关的能力会给出提示，其他会话蒸馏功能仍可使用。

还可以下载同一发布页中的 ZIP 备用包：

```text
安装并启动.cmd       安装到当前 Windows 用户目录，然后启动
直接启动.cmd         不安装，从解压目录直接运行
检查安装包.cmd       检查运行环境、界面、服务和隐私清单
修复安装.cmd         重建入口并检查当前安装
回滚上一版本.cmd     升级异常时恢复上一版本
使用说明.html        给新手看的图形化说明
```

默认安装目录：

```text
%LOCALAPPDATA%\WorkCapabilityDistiller
```

默认只监听本机 `127.0.0.1`。启动器会在 `8960-8999` 中自动寻找空闲端口，不需要用户研究端口号。

### 从源代码启动

适合开发者、贡献者和希望查看全部实现的人：

```powershell
git clone https://github.com/wzn1118/work-capability-distiller.git
cd work-capability-distiller
npm ci
npm run session:ui
```

要求 Node.js 22。服务启动后会在终端显示实际本机地址。

## 第一次打开会看到什么

主工作台采用左侧导航和右侧单页工作区，核心入口分成三组：

1. **本机会话**：发现、搜索和选择本机 Codex 工作记录。
2. **网页会话**：连接并管理 ChatGPT、DeepSeek、Gemini 和豆包网页聊天。
3. **蒸馏结果**：查看系统理解、证据、P0-P3 建议和已经生成的能力包。

零代码用户通常只需要完成：

```text
选会话 -> 开始智能蒸馏 -> 看推荐 -> 生成并打开能力包
```

项目路径、会话文件、导出目录和工作区都提供选择器。高级模型配置、保留策略和技术证据收在高级区域，日常路径不会先把一排技术名词摆到用户面前。

## 它究竟蒸馏什么

蒸馏输入不止聊天正文。系统会把一次工作拆成九类信息：

| 信息 | 系统关注的内容 |
|---|---|
| 用户目标 | 最终要解决什么问题，交付给谁 |
| 最新纠正 | 用户后续否定、替换或强化了哪些旧要求 |
| 会话内容 | 用户消息、助手回复、代码块、附件和分支 |
| 工具调用 | 文件读取、命令执行、网页检索、图片或媒体工具等 |
| 项目文件 | 当前版本、原始版本、修改内容和依赖关系 |
| Git 证据 | 状态、差异、提交、分支和可追溯基线 |
| 生成产物 | 报告、代码、表格、演示文稿、图片、ZIP 等 |
| 验证结果 | 测试、命令、人工验收、失败记录和恢复点 |
| 数据身份 | 实际业务对象、数据批次、覆盖范围和限制条件 |

最终能力会写成具体的“对象 + 动作 + 方法 + 产物”，例如：

```text
P1 | 评论与视频数据全量洞察及报告生成
输入：评论明细、视频摘要、目标人群、参考报告
执行：清洗 -> 分层统计 -> 语义主题 -> 机会识别 -> 报告生成
产出：可审计数据表、洞察报告、重点建议、验证记录
证据：会话阶段、分析脚本、文件差异、最终报告、验证命令
```

## 三种蒸馏范围

项目目录里可能同时放着很多工作，系统不会因为看到一个大文件夹就把所有内容倒进能力包。

| 范围 | 会读取什么 | 适合场景 |
|---|---|---|
| 单会话 | 当前所选会话和它直接引用的证据 | 复用一次明确工作 |
| 多会话 | 仅合并所选会话，按目标、文件、产物和时间聚类 | 汇总连续迭代或多角色协作 |
| 完整项目 | 用户明确选择项目后，筛选与目标相关的规则、文件、Git 和产物 | 理解一个项目级工作能力 |

完整项目模式会列出纳入文件、排除文件和理由。单会话或多会话模式不会偷偷带入整个工作区背景。

## 本机会话模块

本机会话索引会扫描可用的 Codex 会话目录，建立可增量更新的列表：

- 显示真实会话标题，而非只显示 UUID；
- 显示最后目标、更新时间、来源工作区和内容规模；
- 支持单选、多选、全选、反选和逐条排除；
- 支持按工作区查看全部会话；
- 支持搜索标题、用户消息、助手回复、工具调用和附件文本；
- 会话变化后只更新发生变化的记录；
- 单条会话可以展开查看完整事件和工具内容。

相关实现：

| 模块 | 职责 |
|---|---|
| `session-source-index.mjs` | 发现会话、提取标题和基础元数据 |
| `workspace-session-index.mjs` | 将会话按工作区归组并维护选择范围 |
| `codex-session-sync-store.mjs` | 保存增量同步状态和覆盖率 |
| `session-content-search.mjs` | 搜索标题与完整正文 |
| `session-semantic-index.mjs` | 建立可用于聚类和语义命名的索引 |
| `session-forensics.mjs` | 解析事件、工具、命令和文件变更证据 |

## 网页会话模块

网页会话和本机 Codex 会话使用独立列表、独立来源标识和独立同步状态。目前包括：

- ChatGPT；
- DeepSeek；
- Gemini；
- 豆包。

支持的工作流：

1. 从主工作台选择平台。
2. 连接当前电脑中已经登录的浏览器页面。
3. 发现真实会话目录。
4. 批量读取会话正文、分支、附件、工具事件和媒体引用。
5. 持久化已读取记录。
6. 下次只同步更新过的会话。

大规模读取具备：

- 3000 条以上会话的批量任务规划；
- 当前阶段、成功数、失败数和正在读取项的进度显示；
- 暂停、继续、取消和失败重试；
- 检查点与断点续读；
- 官方导出 ZIP 与网页捕获结果对账；
- 单会话原始载荷、分支树、资产和工具事件查看。

网页读取复用用户当前浏览器登录状态。Cookie、令牌、Authorization 和模型密钥不会写入能力包、公开 URL 或导出清单。

相关实现：

| 模块 | 职责 |
|---|---|
| `chatgpt-export-store.mjs` | 导入并索引官方导出内容 |
| `chatgpt-incremental-sync.mjs` | 任务队列、检查点、暂停、继续和增量同步 |
| `chatgpt-web-link.mjs` | 独立 Agent 与网页伴侣的本机连接 |
| `chatgpt-companion/` | 浏览器伴侣页面读取器与配对界面 |

## 项目理解模块

当用户明确选择完整项目时，系统按证据主动理解：

- 工作目录和项目根；
- `AGENTS.md`、`README.md` 和贡献规则；
- 依赖清单、入口文件、构建脚本和测试配置；
- 当前 Git 状态、原始版本和差异；
- 会话中实际出现的文件；
- 生成文件使用了哪些输入；
- 哪些变化经过测试或人工验证；
- 哪些内容与当前目标无关，应该排除。

| 模块 | 职责 |
|---|---|
| `project-discovery.mjs` | 发现候选项目并计算关联证据 |
| `project-understanding.mjs` | 生成面向用户的项目理解结果 |
| `project-evidence.mjs` | 建立文件、Git、命令、产物和验证证据 |
| `project-knowledge-v4.mjs` | 生成项目知识、文件版本链和证据账本 |
| `scope-policy.mjs` | 严格区分单会话、多会话和完整项目范围 |

## 证据图谱与稳定编号

系统会建立以下关系：

```text
用户纠正
  -> 会话阶段
  -> 工具调用
  -> 文件变化
  -> Git 原始版本与差异
  -> 生成产物
  -> 验证结果
  -> 能力声明
```

关键证据使用内容寻址编号。新增一条无关记录不会让旧证据编号整体漂移。结论可以继续追到消息、文件、行号、哈希、工具结果和产物。

证据不足时，系统会明确标注候选、受限或阻断状态。它很愿意承认“这里还缺一块拼图”，不会为了让页面看起来热闹就补一段猜测。

## 语义蒸馏与优先级

`conversation-ai-distiller.mjs`、`semantic-distillation-v2.mjs` 和 `distillation-recommendation.mjs` 共同完成：

- 提取对象、目标、动作、方法和产物；
- 识别最新用户纠正与旧方案冲突；
- 合并重复阶段，同时保留全部来源；
- 生成业务语义包名；
- 输出蒸馏优先级、Agent 执行优先级和证据置信度；
- 生成可解释的推荐理由。

P0-P3 的含义：

| 优先级 | 含义 |
|---|---|
| P0 | 最新纠正、身份冲突、失败验证、核心依赖等必须先处理的事项 |
| P1 | 输入输出清楚、真实跑通、有产物和验收的核心能力 |
| P2 | 文件模板、补采、验证、自动化和复用增强 |
| P3 | 一次性探索、低置信度候选和待确认流程 |

每一项都会解释：为什么排在这里、引用了哪些证据、生成后先做什么、预计交付什么。

## 能力中间表示

蒸馏结果会先进入统一中间表示，再编译为不同交付物。这样 Skill、MCP、Agent 和 UI 使用同一组事实，不会各写各的版本。

中间表示覆盖：

- 主题身份与数据身份；
- 输入契约和输出契约；
- 观察值、分母、范围和限制；
- 文件覆盖和指标可用性；
- 用户修正与方案冲突；
- 证据图与执行图；
- 重试、检查点与回滚；
- 可移植依赖和发布判断。

相关实现位于 `session-forensics/lib/ir/`、`semantic-distillation-v2.mjs` 和编译器测试中。

## 能力包编译器

`conversation-packager.mjs`、`package-work-capability.mjs` 和 `root-capability-packager.mjs` 会把蒸馏结果装进完整包体。

标准能力包包含：

```text
README.md                    新手入口和启动方法
CAPABILITY.md                能做什么、适用任务、输入输出和边界
PRIORITY-PLAN.md             P0-P3、执行顺序、原因与证据
TASK-CATALOG.md              可以直接交给 Agent 的任务清单
recommendation.json          机器可读建议
evidence-manifest.json       会话、文件、Git、产物和验证证据索引
conversation-distillation.*  会话专属蒸馏结果
project-understanding.*      按需生成的项目理解
skill/SKILL.md               可安装 Skill
mcp/                         MCP 服务、配置和使用说明
agent/                       独立执行型 Agent
agent/ui/                    与能力特性匹配的中文界面
launch.cmd / launch.sh       直接启动入口
install-and-start.cmd        Windows 一键安装与启动
```

包名来自会话内容、工具和实际产物，例如：

- `PPT 多版本融合与高质量演示文稿重构能力包`；
- `评论与视频全量洞察报告自动化能力包`；
- `多会话项目证据蒸馏与可安装 Agent 生成能力包`。

命名依据会写进页面和说明，用户可以看到名称引用了哪些主题、文件、工具和最终修正。

## Skill 模块

Skill 面向 Codex 或兼容的本地 Agent 环境。它保存：

- 什么时候触发；
- 需要读取哪些上下文；
- 推荐步骤与顺序；
- 输入输出契约；
- 失败后的恢复方式；
- 验收标准；
- 证据和示例。

生成的 Skill 可以独立安装，也可以和 MCP、Agent 一起交付。

## MCP 模块

能力包可以生成标准 MCP 服务，让其他支持 MCP 的客户端调用蒸馏能力。服务包含：

- 标准初始化与工具发现；
- 会话阶段和最新纠正读取；
- 项目检查、文件读写和标准补丁；
- Git 状态、差异和日志；
- 命令、验证和长进程管理；
- 检查点创建与恢复；
- 项目理解和证据查询。

MCP 的输入输出契约和 Agent 使用同一份能力中间表示。

## 独立 Agent 模块

独立 Agent 能完成一条真实本地工作闭环：

```text
理解目标
  -> 检查工作区和项目规则
  -> 匹配 P0-P3 能力
  -> 制定可回放步骤
  -> 搜索、读取和修改文件
  -> 执行命令或管理长进程
  -> 查看 Git 差异
  -> 运行验证
  -> 展示产物与证据
  -> 必要时重试、继续或恢复检查点
```

工具包括：

- 文件列表、路径检查、内容搜索和读取；
- 新建目录、写文件、替换文本、批量编辑和标准补丁；
- 移动、删除、检查点和恢复；
- 命令执行、验收命令、长进程启动、输出读取、输入和停止；
- Git 状态、差异、日志、分支和提交；
- 项目规则读取、技能发现和技能说明读取；
- 在启用网络权限后读取网页内容。

Windows 使用 `taskkill /T` 回收进程树；Linux 和 macOS 使用独立进程组，先优雅终止，再清理残留后代。CI 中包含真实长进程停止测试。

## 独立 Agent UI

每个包的 UI 根据能力特征生成布局和任务入口，避免所有包长得像同一张聊天模板。界面会展示：

- 这项能力的直白说明；
- 适合交给它的任务；
- 当前匹配的 P0-P3 能力；
- 即将读取和修改的文件；
- 即将执行的命令；
- 实时日志和工具轨迹；
- 文件差异、生成产物和验证结果；
- 继续、重试、停止和恢复检查点。

主工作台只负责蒸馏和管理，网页聊天读取也只放在主工作台。生成后的独立 UI 专注执行当前能力，不会把主工作台的采集功能塞进去。

## 模型连接

独立 Agent 支持 OpenAI 兼容接口，并能读取本机已有的兼容配置。运行时配置具备：

- 模型地址、模型列表和当前模型；
- 普通响应和 SSE 流式响应；
- 工具调用消息；
- 运行时更新配置；
- API Key 只在内存和环境变量中使用；
- 状态接口只返回 `hasApiKey`，不会返回密钥正文。

没有模型服务时，蒸馏器仍会使用确定性证据规则生成基础建议、证据清单和能力包结构。模型主要增强语义命名、摘要和任务表达。

## 本机 API

主工作台提供 `/api/v2` 接口，完整定义可从以下地址读取：

```text
GET /api/v2/openapi.json
```

常用接口：

```text
GET  /api/v2/workspaces
POST /api/v2/codex/sync
GET  /api/v2/codex/sessions
POST /api/v2/session-search
POST /api/v2/project-context/preview

POST /api/v2/runs
GET  /api/v2/runs/:runId
GET  /api/v2/runs/:runId/recommendation
GET  /api/v2/runs/:runId/recommendation.html
GET  /api/v2/runs/:runId/priorities
GET  /api/v2/runs/:runId/evidence/:evidenceId
POST /api/v2/runs/:runId/reprioritize
POST /api/v2/runs/:runId/package

GET  /api/v2/packages/:packageId
GET  /api/v2/packages/:packageId/download
POST /api/v2/packages/:packageId/agent/start
POST /api/v2/packages/:packageId/agent/stop

POST /api/v2/chatgpt/import/export
GET  /api/v2/chatgpt/conversations
POST /api/v2/chatgpt/edge/discover
POST /api/v2/chatgpt/edge/capture-all
POST /api/v2/chatgpt/edge/resume
```

接口默认仅对本机开放。运行编号和证据编号用于追踪任务，密钥和浏览器凭证不会放进 URL。

## Windows 安装器做了什么

一键安装并不等于把文件随便复制过去。它执行一套可恢复状态机：

```text
检查包体与隐私清单
  -> 停止本包启动的旧工作台
  -> 复制新版本到 .next
  -> 保留旧版 output 产物
  -> 对新版本执行第二次自检
  -> 当前版本备份为 .previous
  -> 原子切换到新版本
  -> 写入 installed-version.json
  -> 创建桌面与开始菜单入口
  -> 启动并打开主工作台
```

升级失败时，现有正式安装保持不变。升级成功后仍保留上一版本，可以通过 `回滚上一版本.cmd` 恢复。

安装包公开传递时不会携带：

- 旧电脑会话；
- 项目源文件；
- 已生成的用户产物；
- `.env`；
- Cookie 和浏览器登录状态；
- API Key、Authorization 或访问令牌。

## 发布物与校验

每次 Windows 构建会生成：

```text
work-capability-distiller-windows-x64-<时间>-setup.exe
work-capability-distiller-windows-x64-<时间>.zip
work-capability-distiller-windows-x64-<时间>-manifest.json
```

`manifest.json` 记录文件名、字节数和 SHA-256。GitHub Actions 的 Windows 作业会真实执行安装、二次升级、产物保留、自检、ZIP 解压和工作台健康检查；上传前还会逐个重新计算文件大小与 SHA-256，确认清单、安装器和 ZIP 彼此对得上，随后才上传上述三个文件。

稳定版放在 [GitHub Releases](https://github.com/wzn1118/work-capability-distiller/releases)。每次提交的最新构建可以在 [Actions](https://github.com/wzn1118/work-capability-distiller/actions/workflows/ci.yml) 对应运行中下载。

## CI 与质量门

CI 分成两个独立作业：

### Ubuntu / Node.js 22

- 锁定依赖安装；
- 源代码差异格式检查；
- 前端生产构建；
- 服务端测试；
- 会话蒸馏器完整测试；
- Agent、MCP、项目理解和进程树回收测试。

### Windows x64 / Node.js 22

- 锁定依赖安装；
- Windows 换机安装测试；
- 单文件安装器和 ZIP 构建；
- 安装器、ZIP 和哈希清单上传。

本项目使用 `actions/checkout@v5` 与 `actions/setup-node@v5`，Action 自身运行在 Node.js 24，项目测试运行在 Node.js 22。

## 本地测试

```powershell
# 前端生产构建
npm run build

# 业务服务测试
npm run test:server

# 会话蒸馏器、MCP、Agent 和证据测试
npm run test:session-forensics

# Windows 一键安装真实测试
npm run test:portable

# 生成 Windows 安装器、ZIP 和哈希清单
npm run release:windows

# 上传前校验最新安装器、ZIP 和哈希清单
npm run release:verify
```

完整本地检查：

```powershell
npm ci
npm run build
npm run test:server
npm run test:session-forensics
npm run test:portable
```

## 目录导览

```text
.github/workflows/ci.yml                 Ubuntu 与 Windows 发布验收

session-forensics/
  ui-server.mjs                          主工作台服务与 /api/v2
  ui/                                    主工作台中文界面
  cli.mjs                                单会话取证命令行入口
  package-cli.mjs                        能力包命令行入口
  build-portable-workbench.mjs           Windows 发布物构建入口
  portable-workbench.test.mjs            Windows 安装、升级与启动验收

  lib/
    session-source-index.mjs             本机会话发现与标题
    workspace-session-index.mjs          工作区归组与多选范围
    session-content-search.mjs           标题与全文搜索
    session-forensics.mjs                工具、命令和文件变更取证
    chatgpt-export-store.mjs              官方导出持久化
    chatgpt-incremental-sync.mjs          网页会话增量同步
    project-discovery.mjs                项目发现
    project-understanding.mjs            项目理解
    project-evidence.mjs                 项目证据
    project-knowledge-v4.mjs             文件版本与知识账本
    semantic-distillation-v2.mjs         语义阶段蒸馏
    distillation-recommendation.mjs      P0-P3 推荐
    conversation-ai-distiller.mjs        模型增强蒸馏
    conversation-packager.mjs            会话能力封装
    root-capability-packager.mjs         Skill/MCP/Agent 根编译器
    portable-workbench.mjs               Windows 安装器生成器

  templates/
    conversation-agent-*                 通用独立 Agent 模板
    root-capability/agent/                执行型 Agent、UI 与运行时
    root-capability/mcp-server.mjs        MCP 服务模板

mcp/                                     会话取证与领域 MCP 服务
docs/                                    架构、体验、安装和验收文档
server/                                  业务服务与数据处理能力
src/                                     React/Vite 业务前端
```

## 模块全景表

| 模块 | 输入 | 主要产出 |
|---|---|---|
| 会话发现 | Codex 会话目录 | 标题化会话列表 |
| 工作区索引 | 会话与工作目录 | 工作区分组、全选和例外 |
| 全文搜索 | 标题、消息、工具、附件 | 可定位的搜索结果 |
| 网页会话连接 | 已登录浏览器页面 | 真实网页会话目录与正文 |
| 增量同步 | 大规模会话目录 | 检查点、进度和持久化列表 |
| 会话取证 | JSON/JSONL/网页快照 | 工具图、代码和文件变更 |
| 多会话聚类 | 所选多条会话 | 项目拆分、时间线和冲突 |
| 项目发现 | 路径、命令和文件引用 | 候选项目与关联理由 |
| 项目理解 | 明确选择的项目 | 相关文件、规则和依赖 |
| 证据图谱 | 会话、文件、Git、产物 | 稳定 evidenceId 与关系图 |
| 语义蒸馏 | 目标、纠正和执行证据 | 具体能力、任务和名称 |
| 优先级引擎 | 能力候选与证据 | P0-P3、原因和置信度 |
| 能力 IR | 蒸馏结果 | 跨 Skill/MCP/Agent 的统一契约 |
| Skill 编译 | 能力 IR | `SKILL.md` 和资源 |
| MCP 编译 | 能力 IR 与工具契约 | 可运行 MCP 服务 |
| Agent 编译 | 能力 IR 与执行图 | 可读写和验证的独立 Agent |
| 专属 UI | 能力特征和任务目录 | 中文可操作独立界面 |
| 工作区工具 | 用户选择的本地目录 | 文件、命令、Git 和检查点操作 |
| 包体校验 | 完整能力包 | 缺失项、敏感信息和可运行性结果 |
| Windows 发布 | 主工作台源码 | EXE、ZIP 和 SHA-256 清单 |
| CI | 每次提交 | Ubuntu 与 Windows 验收状态 |

## 隐私与权限

- 主工作台默认绑定 `127.0.0.1`；
- 网页聊天登录态留在浏览器中；
- 密钥不写入导出包、URL 和证据页面；
- 文件写入、删除、命令、Git 写入和网络访问分别控制；
- Agent 只能在用户选择的工作区边界内操作文件；
- 每次任务保留计划、工具轨迹、文件变更、命令和验证结果；
- 能力包发布前检查绝对路径、缺失资源和敏感信息。

请在使用独立 Agent 前确认工作区选择正确。涉及写入、删除、命令执行或 Git 提交时，界面会显示对应权限和执行内容。

## 常见问题

### 新电脑没有 Node.js，可以安装吗？

可以。Windows 发布包包含 Node.js 运行环境。源代码开发方式需要 Node.js 22。

### 安装需要管理员权限吗？

默认安装到当前用户的 `%LOCALAPPDATA%`，通常不需要管理员权限。企业设备仍可能受到安全策略限制，此时可使用 ZIP 包并让管理员审查。

### 为什么工作台没有固定端口？

固定端口可能已被其他程序占用。启动器会在 `8960-8999` 自动选择可用端口，并直接打开正确地址。

### 换电脑后旧会话会自动出现吗？

工作台会发现新电脑本机存在的 Codex 会话。旧电脑会话、项目和浏览器登录态不会被偷偷塞进公开安装包。需要迁移的能力包可以单独复制 ZIP。

### 网页聊天为什么需要浏览器连接？

网页会话属于用户当前登录页面。浏览器连接让读取动作发生在用户自己的登录环境中，同时把凭证留在浏览器里。

### 没有模型 API 还能用吗？

可以完成会话解析、项目证据、确定性优先级和基础能力包生成。配置兼容模型后，语义命名、摘要和任务表达会更完整。

### 生成的 Agent 真会改文件吗？

会，但前提是用户选择工作区并开启写入权限。命令执行、删除、Git 写入和网络访问拥有独立开关。

### 升级失败怎么办？

安装器只在新版本通过自检后切换目录。上一版本保存在 `.previous`，可运行 `回滚上一版本.cmd`。

### CI 中为什么同时跑 Ubuntu 和 Windows？

Ubuntu 负责验证跨平台代码、服务和完整蒸馏链。Windows 负责真正构建并安装换机包。两边都通过，发布状态才可信。

## 排障入口

| 现象 | 先做什么 |
|---|---|
| 双击后没有打开页面 | 查看启动窗口中的实际地址和错误信息 |
| 提示端口不可用 | 关闭旧工作台后重试，或让启动器自动选择其他端口 |
| 安装包不完整 | 运行 `检查安装包.cmd`，重新下载并核对 SHA-256 |
| 桌面入口丢失 | 运行 `修复安装.cmd` |
| 升级后异常 | 运行 `回滚上一版本.cmd` |
| 找不到本机会话 | 在本机会话页刷新索引，检查当前用户的 Codex 会话目录 |
| 网页会话未更新 | 查看同步任务状态，从最近检查点继续或重试失败项 |
| Agent 找不到文件 | 重新选择工作区，检查范围预览和排除理由 |
| 命令执行被阻止 | 检查 Agent 的命令权限和当前系统工具是否存在 |

## 参与开发

欢迎围绕这些方向提交 Issue 或 Pull Request：

- 新的会话来源适配器；
- 更完整的工具、附件和媒体事件解析；
- 更聪明的多会话聚类与项目范围判断；
- 证据图谱、回放和留出任务评估；
- 独立 Agent 的执行、恢复和验证工具；
- 更清晰的新手界面与可访问性；
- Windows 安装、升级、签名和跨平台发布。

提交前建议运行：

```powershell
npm ci
npm run build
npm run test:server
npm run test:session-forensics
```

涉及 Windows 安装器时，再运行：

```powershell
npm run test:portable
```

## 最后一句

这个项目想保存的并不只是某段漂亮回答。它更在意一项工作怎样被理解、怎样被修正、怎样真正跑通、怎样验收，以及下一位使用者怎样少踩几个坑。

一次完成可以只解决今天的问题。一份经过证据蒸馏、能够安装和执行的能力包，还能给明天留下一条清楚的路。
