# DS-BB-012：历史会话路径重映射（R 方案）隔离验证

- 日期：2026-11-19
- 性质：隔离环境运行时验证（真实 DSH 引擎 + Mock LLM，不连接真实模型、不触碰用户真实数据）
- 技术基线：本仓库 main 合并点 `5e9b7da8`，DSH 固定版本 `@deepseek-ai/*` 0.2.2-rc.1（`app/node_modules` 中经 `npm ci` 安装的 pinned 包）
- 前置依据：[DS-BB-011R-session-recovery-audit.md](DS-BB-011R-session-recovery-audit.md)（R 方案 = `workingDirectory.set(agent, newPath)` 追加 `working-directory/change` 事件）
- 证据目录：`docs/process/dsbb012-artifacts/`（各阶段 results JSON、console 日志、Mock 请求日志、帧完整性快照）
- 测试数据：`.dsh-test-dsbb012/`（gitignore 覆盖，与 `~/.dsh` 及桌面应用自身数据完全隔离）

## 0. 证据等级约定（本文使用）

| 等级 | 含义 |
|---|---|
| **A** | 本轮在真实引擎（pinned DSH 0.2.2-rc.1）中实际执行、可复现的结果（引擎恢复会话、真实写入帧、Mock 模型回合完成） |
| **B** | 静态源码验证：逐行读过的实现 |
| **C** | 由 A/B 级事实组合推出的结论 |
| **D** | 不可验证项 |

## 1. 方法概述

每个验证步骤在**独立的 Node 进程中冷启动 pinned DSH 运行时**（`@deepseek-ai/dsh/profile-boot` 的 `runProfile`，与桌面应用同一入口），使用同一 scratch `DSH_HOME`；进程边界即"重启引擎"。LLM 路由通过环境变量 `DEEPSEEK_BASE_URL`/`DEEPSEEK_API_KEY` 指向本地 `ds-bot/dev/mock-llm.mjs`（既有 Mock，任务允许复用）；遥测与 session-log 上传通过 profile overlay（`DSH_TELEMETRY_DISABLED` + 禁用 `session-log-deepseek` 行）关闭，全程不接触任何外部业务服务。

测试脚本：
- `ds-bot/dev/dsbb012/engine-stage.mjs` — 单阶段引擎驱动（create/reproduce/remap/verify/turn/idempotent）
- `ds-bot/dev/dsbb012/run.mjs` — 编排器（隔离环境搭建、帧完整性快照、Mock 生命周期、证据归档）
- `ds-bot/dev/dsbb012/frames.mjs` — 帧结构扫描 + SHA-256 完整性助手（帧扫描逻辑镜像 `dsh-session-persistence-jsonl` 的 `scanZstdFrames`，不 import 产品代码）

## 2. 012-A：隔离环境

| 项 | 值 |
|---|---|
| 测试 DSH_HOME | `.dsh-test-dsbb012/dsh-home`（与用户 `~/.dsh` 隔离） |
| 旧工作区（012-B 创建会话时存在） | `.dsh-test-dsbb012/workspaces/old-team-ws` |
| 新团队工作区 | `.dsh-test-dsbb012/workspaces/new-team-ws` |
| Mock LLM | `ds-bot/dev/mock-llm.mjs`，detached 进程，随机端口记录于 `paths.json` |
| 固定会话 ID | `dsbb012-session-001`（fixture 主会话）/ `dsbb012-control-001`（012-G 对照） |

隔离确认（A）：`paths.json` 记录 `userDshTouched: false`；所有数据根均在仓库内 `.dsh-test-dsbb012/`；`loadLayeredEnv` 在数据根/仓库根均无 `.env` 层可读。

## 3. 012-B：构造历史会话（真实引擎，A 级）

由真实引擎 `sessionController.create({ sessionId, cwd: <旧目录> })` 铸造 fixture 会话并完成**一次 Mock 模型回合**（旧目录当时存在）：

- `stage-create.json`：`eventCount: 21`，`turn/end { turn:1, reason:{kind:"completed"} }`，Mock 请求 2 条（1 条主回合 + 1 条会话标题生成）
- 原始 zstd 帧基线（`integrity-before-remap.json` + 字节原件 `integrity-before-remap.bin`）：5 帧，整文件 20332 字节，SHA-256 `466d0013…`
- 工件路径由运行时自身解析并回报（`artifactLocation`）：
  `sessions/<projectKey(旧cwd)>/dsbb012-session-001/session.v4.jsonl.zstd`

> 格式兼容性确认（A）：会话文件由 pinned 运行时创建，`stat().formatStatus === "current"`（见 012-E），即与固定运行时完全同代，无需迁移。

## 4. 012-C：原始故障复现（真实引擎，A 级）

编排器将旧目录 `rename` 为 `old-team-ws.removed`（保留现场，不删除），随后冷启动引擎执行 fixture 会话的一个新模型回合：

- 会话**可发现**（`list()` 命中，`listDiscovered: true`）
- `resolveAgent` **成功恢复**（`resumed: true`）
- `workingDirectory.get()` 仍为**旧路径**（`getcwd` = old-team-ws）
- 模型回合**失败**，`turn/end` 实际落盘：
  `{"kind":"error","error":{"message":"working-directory: directory does not exist: \"…old-team-ws\"","code":"UNKNOWN"}}`
- 失败期间 Mock 请求数 = **0**（故障发生在 `ensure()` 校验、模型调用之前）

与 011R 审计预期（§3.4，B 级）逐项吻合：故障点正是 `dsh-working-directory` 的 `ensure()`（`app/node_modules/@deepseek-ai/dsh-working-directory/lib/index.js:91-106`）——当前目录缺失后回退 `header.cwd`（仍是旧路径），两者都不可用即拒绝一切模型回合。**实际行为未强行套用审计结论，审计预期与实测一致。**

## 5. 012-D：执行 R 重映射（真实引擎，A 级）

冷启动引擎：`resolveAgent` → `workingDirectory.get(agent.session)`（= 旧路径，与 `newDir` 不同 → 需要映射）→ `workingDirectory.set(agent, 新目录)`：

- `setCallsMade: 1`，`remappedTo` = 新团队工作区
- 会话事件日志中追加了 `working-directory/change`（`data.cwd` = 新路径；**帧级解码实证**：对 012-B 基线文件之后的新增 zstd 帧做解压解码，可见该事件及其 `agent/inbox/spliced` 通知帧）
- `getcwdAfter` = 新路径（投影已更新）
- 记录一个实现细节（A 级观察，不影响结论）：`set()` 返回时**投影**已指向新路径，但阶段内的只读句柄快照尚未包含新帧——JSONL 后端的活写路径按有界批次窗口落盘（`session/event` → 批次 → 物化帧），物化发生在排空/关闭时。因此 `stage-remap.json` 的 `changeEvents` 为空是读句柄快照时点所致；持久化证据以**帧级解码**（`integrity-after-remap.json` 对应帧 + 独立解码脚本输出）为准
- 原 5 个帧**字节级不变**（`originalFramesIdentical: true`，前缀 append-only：20332 → 21387 字节，新增 4 帧 / 1055 字节）
- 整文件哈希按设计改变（`wholeFileHashChanged: true`，R 方案追加新帧）——**对比基准为帧级而非整文件**，原始事件帧逐帧哈希一致
- 未使用任何私有持久化 API；变更面是 DSH 存储契约规定的 append-only 正常路径

## 6. 012-E：重启验证（真实引擎冷启动，A 级）

同一 `DSH_HOME`、同一 pinned 运行时，全新进程：

- `list()` 发现该会话（`discovered: true`，`listedSessionCount: 1`，同 ID）
- `stat().formatStatus === "current"`（无损坏会话报错）
- `resolveAgent` 成功
- `workingDirectory.get()` = **新路径**（映射在重启后保留）
- `ensure()` 通过并返回新路径

## 7. 012-F：真实引擎中的 Mock 模型回合（A 级）

重启后的引擎对已重映射的 fixture 会话发起一次新模型回合：

- Mock 日志收到该请求（`first` 含 "ping after the remap"），返回固定纯文本应答（无工具调用 → `end_turn`）
- 引擎完成回合：会话文件落盘 `turn/start` → `user/message`（ping after the remap）→ `request/header` → `assistant/message`（turn 3）→ `turn/end {"kind":"completed"}`
- 回合证据 = 实际到达 Mock 的请求 + 引擎实际完成的 `turn/end {completed}` + Mock 实际应答；**不是**"API 成功/代理创建/事件存在"的弱证据

## 8. 012-G：幂等 + 数据完整性（A 级）

- 对已映射会话重跑映射守卫：`get` 已等于新路径 → **不发起第二次 `set`**（`guardIsNoOp`，`setCallsMade: 0`）
- **无重复 `working-directory/change` 事件**：重跑后该事件计数保持 1（`noDuplicateChangeEvent`）
- 原始事件帧**字节级不变**（`originalFramesIdentical`）——任务规定的对比基准是**帧级**而非整文件：引擎在每次恢复/收尾时自行追加生命周期帧（`session/end-seed`），整文件哈希按设计改变（`wholeFileHashChanged: true`），属引擎正常 append-only 行为而非守卫缺陷
- 对照会话（`dsbb012-control-001`，创建并回合于**新工作区**，独立会话工件文件）：正常完成自己的回合（`turn/end {completed}`），自身 0 条 `working-directory/change`，未被映射守卫触碰
- `list()`/`stat()`/`open()` 对该会话无损坏报错（`formatStatus: "current"`）
- 测试收尾：Mock 进程停止、端口释放确认（`process-cleanup.json`：`port no longer answering — mock released`）

## 9. 逐结论证据等级

| # | 结论 | 等级 |
|---|---|---|
| 1 | 旧工作区缺失时，历史会话仍**可发现、可恢复**（`resolveAgent` 成功） | **A** |
| 2 | 旧目录缺失时，模型回合在 `working-directory.ensure()` 处失败，错误信息 `working-directory: directory does not exist`，且**未发出任何模型请求** | **A** |
| 3 | `workingDirectory.set(agent, 新路径)` 以 append-only 方式追加 `working-directory/change`，原帧字节不变，整文件哈希按设计改变 | **A** |
| 4 | 重映射在引擎**冷重启后保留**：`get()` 返回新路径，`ensure()` 通过 | **A** |
| 5 | 重映射后，真实引擎可在该历史会话上**完成一次 Mock 模型回合**（Mock 请求 + `turn/end {completed}`） | **A** |
| 6 | 映射守卫幂等：已映射会话不产生重复事件、文件不变；对照会话不受影响 | **A** |
| 7 | `list()`/`stat()`/`open()` 对重映射会话无损坏会话报错 | **A** |
| 8 | 侧边栏工作区分组仍按 `header.cwd` 的 realpath（`attachSession` 硬校验），R 方案不改变分组归属 | **B**（011R §3.5，本轮未验证 UI 分组） |
| 9 | Mock 回合中会话标题生成也走同一 Mock 路由（多 1 条请求） | **A**（观察）/ **C**（标题服务默认启用所致） |

## 10. 失败处理与停止条件核对

- 全程无故障（各阶段 exit 0）；若某阶段失败，编排器按任务约定**保留现场、停止后续阶段、写入 `results.json`**，不强行套用结论、不切换 W 方案、不把部分通过报为全部通过
- 未使用 W 方案 / 头改写 / 目录移动；未修改 DSH 运行时源码；未触碰 `app/src/import.mjs`、产品身份配置、更新源/版本策略；未连接真实模型与外部业务服务；未执行任何 `git checkout/reset/clean/stash/commit`
- 官方 API 全程可用，无"实际不可用"情形

## 11. 停止条件

本任务结束：提交本验证报告与 `docs/process/dsbb012-artifacts/` 全部证据（阶段 JSON、console 日志、Mock 请求日志、帧完整性快照与对比），**不执行 Git commit**，等待负责人审核后确定下一阶段。
