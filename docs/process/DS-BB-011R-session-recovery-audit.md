# DS-BB-011R：历史会话恢复与工作区路径重映射技术审计

- 日期：2026-11-19
- 性质：只读技术审计（不修改产品源码、不修改历史会话、不跑真实模型）
- 审计基线：本仓库 main 合并点 `5e9b7da8`（DSH 固定版本 `@deepseek-ai/*` 0.2.2-rc.1，取自 `app/package.json` 与 `ds-bot/dev/harness/package.json` 的 pinned 依赖，经 `npm ci` 安装到 `app/node_modules` 后直接阅读）
- 审计范围声明：全部结论基于下文的源码文件与行号；没有任何一个历史会话被真实 DSH 引擎恢复过，本文所有"行为"描述除特别标注外均为静态源码推断（B/C 级），不构成 A 级运行时证据。

## 0. 证据等级约定（本文使用）

| 等级 | 含义 |
|---|---|
| **A** | 本轮有真实运行/可复现执行的证据（引擎实际恢复会话、实际写帧等）。**本轮没有 A 级证据**（遵守任务限制：不连接真实模型、不跑引擎恢复）。 |
| **B** | 静态源码验证：逐行读过的实现，行为可直接从代码推出，但未实际执行。 |
| **C** | 推断：由 B 级事实与文档（README/包说明）组合推出的结论，代码路径存在但依赖运行环境。 |
| **D** | 不可验证：超出本轮可读范围（如 DSH 上游源码、用户真实数据行为）。 |

## 1. 关键结论（TL;DR）

1. **发现与读取不依赖旧 cwd 是否存在**（B）。DSH 用目录扫描发现会话：`<DSH_HOME>/sessions/<projectKey(cwd)>/<encodeSegment(id)>/session.v4.jsonl.zstd`。`findLog` 遍历所有 project 目录找 `encodeSegment(id)`，身份校验 `assertStoredIdentity` 比较的是"由 header 的 `id`+`cwd` 推导出的路径"与"实际路径"是否一致——旧路径在磁盘上**不存在**不影响这一校验（它做的是路径字符串/realpath 相等比较，不是存在性检查）。
2. **`header.cwd` 是旧路径的硬约束点只有一个：`dsh-working-directory` 服务的 `ensure()`**（B）。该服务随 `dsh-base` 默认挂载，在每次组装 system prompt（`system-prompt/assemble` 钩子，prepend）时校验"当前有效目录"；若当前目录缺失，则回退到 `header.cwd`（即旧路径）并再次校验，两者都不可用时**抛出错误，拒绝该会话的一切模型回合（连纯聊天回合也被拒绝）**。这是历史会话"不能干活"的真正根因，而不是读取/恢复阶段。
3. **DSH 没有提供任何官方 API 来改写 `header.cwd`、迁移项目目录或把会话重新挂到别的工作区**（B）。包级公开导出里没有 `projectKey`/`encodeSegment`/帧压缩函数（它们是模块私有），会话格式迁移机制（v0→v4 相邻迁移）只处理"版本"，不处理"路径"。
4. **存在一条完全受支持、不碰二进制的重映射方案（R 方案）**（B）：通过公开的 `dsh-working-directory` 服务的 `set(agent, newPath)` 向会话**追加**一条 `working-directory/change` 事件（append-only，走正常的写句柄批量帧），把该会话的"有效工作目录"指向新团队工作区；header、zstd 帧、session id、目录位置全部不动。追加是 DSH 存储契约规定的唯一正常变更面（"committed events are never rewritten; append-only"）。
5. **若要求会话在侧边栏正确分组到新工作区，则 R 方案不覆盖**（B）：`dsh-workspace` 注册表只按 `header.cwd` 的 realpath 分组，且 `attachSession` 强校验 `header.cwd` 与新工作区路径相等——无法通过公开 API 绕过。要修分组只能改写 header 帧 + 移动目录（W 方案，非受支持、有版本脆弱性）或向上游提 issue（D 级，结果不可控）。
6. **DS-BB-011 的 `summary.workspace` 映射在本分支代码中并不存在**（B）：`app/src/import.mjs` 当前写出的 `imported.json` 只有 `from, at, dsh, bots, rooms, sessions, missingSessions, keys, keptKeys, modelSettings, workFiles` 字段，没有任何 DSH Runtime 代码读取它。**它目前对 DSH Runtime 没有作用，也无需作用**——R 方案不需要它；若未来做 W 方案，它可作为新旧路径映射的输入数据。

## 2. Session 数据格式（B 级，全部读自 `dsh-session-persistence-jsonl/lib/index.js`）

### 2.1 磁盘布局

```
<root> = <DSH_HOME>/sessions        # dsh-base/cordis.patch.yml:141 `root: !!js dshHomePath('sessions')`
  --<projectKey(cwd)>--/           # 可读项目目录；cwd 缺省时为 _no-cwd/
    <encodeSegment(id)>/
      session.jsonl.zstd           # v0
      session.v1.jsonl.zstd ... session.v4.jsonl.zstd   # 当前版本 = v4
```

- 当前格式版本：`dsh-session-format-catalog/lib/index.js:41` → `currentVersion: 4`。运行时取编号最高的 generation。
- `encodeSegment(raw)`（index.js:858）：对任意字符串单射地转成一个安全路径段——`~XXXX`（十六进制码元，大写，4 位补零）转义；`.`/`..` 特判为 `~002E`/`~002E~002E`。
- `projectKey(cwd)`（index.js:880）：有损的人读键——`/ \ :` 折叠为 `-`，其余安全字符原样，其余转 `~XXXX`；结果形如 `--C:-Users-x--`，截断到 251 字符。**注意它是有损的（多个 cwd 可同键），但会话 id 段仍是唯一选择器。**
- 路径推导：`projectDir(root, cwd)` → `sessionDir(root, cwd, id)` → `generationLogPath(root, cwd, id, version, compression)`（index.js:907-943）。**目录位置完全由 header 里的 `cwd` 决定。**

### 2.2 header 行与 zstd 帧

- header 行是 `{"type":"session","version":4,"id","createdAt","isSeeded","delegationDepth"}` 加可选 `cwd`（必须为绝对路径字符串）、`parentSession`、`origin`、`agentPreset`（`isHeaderLine` 守卫，index.js:835-845）。
- 物理编码 = 标准 Zstandard 帧的**独立串联**：第 1 帧只装 header 行，之后每个持久化追加批 1 帧（README "Physical encoding" 节，B 级；`encodeMaterialization` index.js:3279 证实 header 与首批事件分帧）。
- 每帧带 64 位 xxhash 校验和：`CHECKSUM_OPTIONS = { params: { ZSTD_c_checksumFlag: 1 } }`（index.js:1296），压缩用 Node 内建 `zlib.zstdCompress`。
- 读端：`scanZstdFrames`（index.js:1310 起）逐帧校验 magic/descriptor/block 结构；`readFirstZstdLine` 只解第 1 帧取 header（list/stat 只读第 1 帧）。**完整的帧校验失败 = 损坏（fail-closed，`SessionPersistenceCorruptionError`）；只有撕裂的最后一帧可被部分恢复。**
- 事件帧是追加的：写句柄 append 一个批 = 追加一个新校验帧 + fsync，"committed events are never rewritten"。

### 2.3 与 cwd 相关的事件

- 事件类型 `working-directory/change`，数据 `{ cwd: string }`（`dsh-session/lib/index.js:140` 已知事件表；`dsh-api-session-controller` 的 `SessionEventMap` 声明同型）。
- 它进入 `dsh-working-directory` 服务的 session projection：`init: (header) => header.cwd ?? null`，`apply: 'working-directory/change' → event.data.cwd`（dsh-working-directory/lib/index.js:35-41）。**即：有效目录 = 投影状态（最后一次 change 事件），缺失时回退 header.cwd，再缺失回退 `defaultDirectory`（= 插件配置的 `defaultDirectory ?? 进程 cwd`，index.js:27）。**

## 3. 发现 / 恢复 / 关联机制（调用链，全部 B 级）

### 3.1 DSH 如何发现历史会话（问题 1）

```
list()  (dsh-session-persistence-jsonl/lib/index.js:2607)
 → listArtifacts (3110) → ensureRootEncoding
   → listGenerations (3056) → mapSessionDirectories (3075)
     → listProjectDirs (3514: readdir(root) 取全部子目录)
     → listSessionDirs (3526: 每个 project 目录下的会话目录)
     → resolveGenerationInDirectory (3423: 取编号最高的 canonical generation)
 → 每个会话: readGenerationHeader (3146: 只解 zstd 第 1 帧 → JSON.parse → isHeaderLine 守卫)
   → assertStoredIdentity (3180 → 3476):
       expectedPath = generationLogPath(root, header.cwd, header.id, storedVersion, compression)
       if (actualPath !== expectedPath && !sameFile(actual, expected))
           throw `corrupt session log "…": header id "…" and cwd identify "…"`
 → 去重: 同一 id 出现在多个 project 目录 → `duplicate JSONL session id "…" appears in multiple project directories`
按 id 直接定位: findLog(id) (3452): 遍历所有 project 目录找 join(project, encodeSegment(id))。
```

**cwd 不存在于磁盘 ≠ 找不到会话**：发现是"扫目录 + 解第 1 帧"，不 stat 项目目录本身。

### 3.2 DSH 如何确定会话所属工作区（问题 2）

`dsh-workspace`（ctx.workspaceRegistry，`dsh-workspace/lib/index.js`）：

- 启动 `[Service.init]`（:371）：若注册表未初始化 → `listStoredHeaders()`（= `sessionPersistence.list()` 的 header 集合）→ `indexHeaders`（:879）：对每个 header，`realpathNormalize(header.cwd)` + `stat(...).isDirectory()` 成功 → `sessionPaths.set(id, canonicalPath)`；**ENOENT → `missingSessionPaths.add(id)`**；其它失败 → `invalidSessionPaths`。
- `bootstrap`（:758）：按可解析的 canonical cwd 把会话分组；组内会话**挂到同路径的已有 workspace 记录上**（app 的新数据位置里团队工作区记录由 ds-bot `roster.js:62` 的 `ensureWorkspace()` → `workspaceRegistry.create(path, 'DS Bot')` 创建），没有记录才新建。
- 投影（:445 `list()`）：`record.sessionIds` 经 `candidateMatches(id, path)` 过滤（:376）：`sessionPaths.get(id) === path || missingSessionPaths.has(id)`。**旧 cwd 已消失（ENOENT）的会话仍可留在旧记录里；但 app 导入时没有拷贝 `storages/`（工作区注册表数据），新数据位置的注册表是空的，且新团队工作区记录创建时 `sessionIds` 为空 —— 历史会话因此"未分组"。**
- `reportFilteredCandidates`（:905）：记录里列了但 cwd 校验不过的会话被逐条 `warn` 过滤。
- `attachSession`（:109）：唯一公开的"挂入"入口，强校验 `realpath(header.cwd) === record.path`，**旧路径 ≠ 新路径时直接 throw，无旁路。**

### 3.3 恢复（resume）链路与 cwd 校验位置（问题 3）

```
ds-bot: rt.resolveAgent(sessionId)      (ds-bot/src/host/delivery.js:10)
 → ctx.sessionController.resolveAgent(id)
 → resolve(id) → resume(id)            (dsh-api-session-controller/lib/index.js:181,192)
   → resumeObserved (304): 要求 observation.header.cwd !== void 0（有 cwd 即可，不校验存在）
   → ctx.agents.resume({ resumeSessionId, agentOptions, setup })
     → AgentLoop.resumeWith            (dsh-agent-loop/lib/index.js:1716)
       → persistence.open(id, 'write') → findLog → readGenerationHeader → assertStoredIdentity
       → handle.read(0) → interruptedTurnClosers → append（撕裂尾修复）
       → sessions.prepare(id, { seed: [...persisted, ...closers], meta: handle.header })
       → initializeAgent（组装 composition；此处不碰文件系统 cwd）
之后第一条消息 → system-prompt/assemble → dsh-working-directory ensure()（:47,91）
```

**resume 阶段（open/read/prepare）对 cwd 的唯一硬约束是 `assertStoredIdentity`（路径自洽），不要求目录存在。cwd 的"存在性"校验全部集中在 `working-directory` 服务的 `ensure()`。**

### 3.4 cwd 指向不存在的旧路径会发生什么（问题 4）

分三层，行为互不干扰：

| 层 | 行为 | 证据 |
|---|---|---|
| 发现/读取 | 正常。`list()/stat()/open()` 只看文件位置与 header 自洽，不 stat 旧路径。 | §3.1 |
| 工作区分组 | 该会话不出现在任何新工作区下（ENOENT → `missingSessionPaths`，但新注册表没有旧记录可挂）；若旧路径指向了别的现存目录则被 `warn` 过滤。仅影响侧边栏显示，不影响功能。 | dsh-workspace:879-905 |
| **模型回合** | **全部被拒绝**。`ensure()`：当前投影目录（= header 旧路径，若从未发过 `working-directory/change`）stat 失败 → 回退 `original = header.cwd`（同一旧路径）→ `directory(original, original)` 再 stat 失败 → **throw `working-directory: directory does not exist`**，沿 `system-prompt/assemble` 钩子冒泡到回合，连 chat-only 回合也失败（包 README "Known Limitations" 原话："when the current directory and the original project are both unavailable, prompt assembly rejects every model turn, including chat-only turns"）。 | dsh-working-directory:91-105 + README |

（以上为 B 级静态推断：调用链与分支逐行读定；"实际会失败"未在本轮引擎执行中验证——与任务书"没有 A 级证据"的已知缺口一致。）

注意一个细节（B）：`defaultDirectory` 只兜底"header 无 cwd"的会话；**有旧 cwd 的会话，`original` 就是旧 cwd，`defaultDirectory` 不参与**，所以靠 app 侧配 `defaultDirectory` 救不了历史会话。

### 3.5 能否不修改历史会话内容完成路径重映射（问题 5）——可以，且 DSH 支持

`dsh-working-directory` 服务（随 `dsh-base/cordis.patch.yml:166-170` 默认挂载，B）：

- `set(agent, path)`（index.js:121）：校验目标目录存在 → `commit`（:138）→ **`agent.session.append("working-directory/change", { cwd: directory })`**（一次正常的 append 批次，写进新的校验帧）→ 注入一条用户可见的目录变更通知消息。
- `set` 不调用 `ensure`，**不要求旧目录存在**——它只校验新目标。agent 只需"活着"（`resolveAgent` 的 resume 链不碰文件系统，§3.3）。
- 效果持久：下次冷启动投影 `init = header.cwd`（旧值）后逐事件 apply，遇到 `working-directory/change` 即得新值；`get()`（:81）返回新值，`ensure` 校验新值 → 通过。
- SDK 侧同一语义：`session/working-directory/set`（`dsh-sdk-jsonrpc-server/lib/index.js:651`，README 明示 `setWorkingDirectory` 为推荐恢复手段）。

**代价与不变量**：会话文件仍留在 `--<旧键>--/` 目录里（header 未动，`assertStoredIdentity` 继续自洽）；历史事件字节零改动；只在日志尾追加 1 事件 + 1 通知消息；session id 不变；不触碰任何格式版本。这是 DSH 存储契约（append-only + 单写句柄）内的正常操作。

### 3.6 官方/内部 API 盘点（问题 6）

| API | 位置 | 能否重映射 cwd |
|---|---|---|
| `workingDirectory.set(agent, path)` / SDK `session/working-directory/set` | dsh-working-directory:121；dsh-sdk-jsonrpc-server:651 | **能（有效目录层面，受支持，R 方案）** |
| `sessionPersistence.open(id,'write').append(events)` | dsh-session-persistence 契约 | 能追加任意事件，但绕过服务校验/串行化，属自造协议；不推荐 |
| `workspaceRegistry.attachSession(id)` | dsh-workspace:109 | 不能——强校验 header.cwd == 记录路径 |
| 会话格式迁移（v0→v4 catalog） | dsh-session-format* | 只处理版本，不处理路径 |
| 改写 header / 迁移项目目录 | —— | **不存在。`projectKey`/`encodeSegment`/`compressZstdFrame` 均为包内私有（包公开导出只有 `apply/name/Config/JsonlCompressionSchema`），上游未提供 relocate/remap API** |

### 3.7 若必须重写会话数据：最小修改范围（问题 7）

- **只改第 1 帧（header 帧）**：把 header JSON 的 `cwd` 换成新路径，重新 `zstdCompress(headerLine, {checksum:1})` 替换第 1 帧；**事件帧字节一律不动**（它们彼此独立、自含校验）。
- 同时**必须移动会话目录**：`sessions/--<旧键>--/<id>/` → `sessions/--<新键>--/<id>/`，否则 `assertStoredIdentity`（由 header.cwd 推导 expectedPath）立即报 "corrupt session log"。
- 会话体内已有的旧 `working-directory/change` 事件（若有）：可不动（历史叙述，不影响功能）；改了属于改写已提交数据，违背 append-only 契约。
- 影响面清单：header 帧 × N 个会话；projectKey 目录 × N；`dsh-workspace` 注册表（新数据位置本就是空的，下次 bootstrap 按新 cwd 分组，自动修复分组）；ds-bot `state.json` 的 `workspaceId`（导入时已 `delete`，无影响）。

### 3.8 重写后的一致性保证（问题 8）

- **zstd 校验**：校验和是"每帧内容"的 xxhash64，替换第 1 帧时随 `zstdCompress(..., CHECKSUM_OPTIONS)` 自动重算；第 2..N 帧原样搬运（字节级复制 + 首帧替换 = 新的合法串联帧文件）。注意：必须整体重写文件（不能原地截断追加），写后 fsync——直接照抄 `materialize` 的 win32/posix 发布逻辑最稳（index.js:3238-3290），但那些也是私有的，只能照语义实现，**这本身就是不支持的私有协议复刻**。
- **Session ID**：不变；`encodeSegment(id)` 目录名不变。
- **projectKey**：按新 cwd 重算（算法在 index.js:880，可独立实现，但属私有约定，DSH 升级若改键规则即失配——`assertStoredIdentity` 会用新键推导路径，旧目录没搬干净就报 corrupt）。
- **会话索引**：无 DB 索引（发现=目录扫描）；`dsh-session-query-sqlite` 未挂在 app 组合里；`dsh-workspace` 注册表在新数据位置是空的，启动 bootstrap 自动重建。唯一需要人工对齐的是 `bot/imported.json`（DS-Bot 自己的簿记）与（若有的）`summary.workspace` 映射。

### 3.9 比改二进制更安全的方案（问题 9）

**R 方案（推荐，全受支持）**：导入完成 / 首次启动后，对每个被导入的历史会话执行一次幂等重映射：

```
for id of importedSessions:
  agent = await ctx.sessionController.resolveAgent(id)      # resume 链不碰 fs
  cur   = ctx.workingDirectory.get(agent.session)           # 有效目录（B: index.js:81）
  if cur !== 新团队工作区路径 && !(await dirExists(cur)):
     await ctx.workingDirectory.set(agent, 新团队工作区路径)  # 追加 working-directory/change（B: index.js:121）
```

- 幂等键：`get() === 新路径` 即跳过；写进 `imported.json`（例如新增 `remapped: [...]` 字段）供重复执行与审计。
- 不修改任何历史字节（append 是 DSH 规定的正常写入面）；不改 header、不动目录、不动格式；对 DSH 升级零脆弱性。
- 局限（如实标注）：① 侧边栏"分组"仍按 header.cwd，历史会话显示在未分组区——可用 `setTeamWorkspace` 之后的正常交互或未来 W 方案补齐；② 每个会话多一条通知消息（token 影响：只在读历史时计一次，B）；③ 需要会话可被 `resolveAgent` 成功 resume（若会话因其它原因损坏则本来就无法使用，不属于重映射职责）。
- 该方案**不需要** DS-BB-011 的 `summary.workspace`（它在本分支不存在，见 §1.6）；重映射关系由"导入记录 + 会话内追加的 change 事件"自身承载。

**W 方案（surgical，仅当"侧边栏正确分组"成为硬性要求时）**：替换 header 第 1 帧 + 移动 project 目录（§3.7-3.8）。风险清单：私有帧协议复刻（校验和、撕裂语义、win32 发布规则全部无公开导出）；DSH 升版（v5 或键规则变化）后文件与 `assertStoredIdentity` 脱钩；违反 AGENTS.md 第 1 条"build on DSH; never patch it"的精神——这是对 DSH 内部存储格式的逆向维护，不是构建在其公开 API 上。**不建议作为默认路线；若做，必须先向上游确认 v4 键/帧约定稳定性（D 级依赖），并把操作写成一次性、可回滚（先全量备份 `sessions/`）的迁移工具。**

**P 方案（兜底）**：在旧路径重建/软链接回原目录，让 `ensure` 的回退路径成功。跨机器（旧 home 换盘/换机）不可行；同机器可做，但属于数据目录操作，维护成本高于 R。

### 3.10 长期维护最优（问题 10）

**R**。理由：① 100% 落在 DSH 公开服务面（`workingDirectory` 服务 + 标准 resume 链），DSH 升级时只依赖"事件词表 + projection 语义"这类 README 承诺的稳定性（"Established record meanings remain stable"，dsh-session-format README）；② 零二进制手术、可幂等重放、失败可重试；③ 与 AGENTS.md 硬规则 1 一致。把 W 写成文档化的应急工具（不默认启用）；同时给上游开 issue 请求"session relocate / register-alias" API，让分组层也有受支持的出路。

## 4. 是否要改 DSH Runtime / 做数据格式转换

- **改 DSH Runtime：不需要，且被禁止**（AGENTS.md 硬规则 1；R 方案完全在公开 API 内）。
- **数据格式转换：不需要**（历史会话即 v4 当前格式，无需 format catalog 迁移；`newerSessions` 检查（app/src/import.mjs:218）只防"更新格式"的会话）。
- **需要的数据动作只有**（R 方案）：对每个历史会话**追加** 1 条 `working-directory/change` 事件 + 1 条通知消息，写在新校验帧里；不移动、不重写、不转换任何既有数据。

## 5. 可验证的测试设计（R 方案落地后应满足）

以下测试全部可以在 mock LLM（`ds-bot/dev/mock-llm.mjs`）+ 测试 bench（`dev/bench.sh`，独立 `.dsh-test-<name>` 数据目录，AGENTS.md 规则 5）内完成，不碰真实数据、不耗模型额度：

1. **单元（ds-bot/test/，仿 `parallel-parts.test.js` 的 Jsonl 用法）**：
   - 造一个"旧 cwd"会话：用 `dsh-session-persistence-jsonl` 的 `create/append`（测试里直接 import 包，已有先例）写 header `cwd=/tmp/dsbb011r-old`（测试环境可造的现存目录，或故意用不存在的目录）。
   - 断言 R 流程前：`workingDirectory.get(session) === 旧路径`；`set(agent, 新路径)` 后：日志尾部出现 `working-directory/change`，且 `zstdDecompress` 每个帧校验和通过（用 `node:zlib` 解帧验证），session id 与既有事件字节未变（哈希对比事件帧）。
   - 断言重启后（重新 boot 引擎、重新 open）：`get() === 新路径`，且 `ensure` 通过（模拟 system-prompt 组装路径）。
2. **bench smoke（`dev/bench.sh smoke <port> ...` + `dev/smoke.mjs` 同款驱动）**：
   - 在测试 DSH_HOME 里放一个旧 cwd 会话 + 一个 ds-bot 团队 state（指向该会话的 bot），跑一次"导入等价物"：拷贝会话、注册新团队工作区、执行 R 重映射脚本。
   - 断言：该 bot 会话能完成一次 mock 模型回合（R 之前该断言应失败且错误为 `working-directory: directory does not exist`——即先写"复现测试"）；`sessions/` 下会话文件仍在 `--旧键--/` 目录且除尾部追加帧外字节未变（`git diff` 式校验）。
   - 断言 `list()`/`stat(id)` 全程无 `corrupt session log`。
3. **回归护栏**：
   - 幂等：重映射脚本跑两遍，第二遍零写入（文件 mtime/大小不变）。
   - 未受影响会话：新会话（无旧 cwd）不产生 `working-directory/change`。
   - W 方案若实现：header 替换 + 目录移动后 `assertStoredIdentity` 通过、bootstrap 分组到预期工作区、原文件备份存在。
4. **证据升级路径（把 B 变 A）**：上述 bench 跑通后，即获得"真实引擎恢复历史会话"的 A 级证据，补齐任务书指出的缺口。

## 6. 逐问速答（带证据等级）

| # | 问题 | 答案 | 证据 |
|---|---|---|---|
| 1 | 如何发现历史会话 | 目录扫描 `<root>/<projectKey>/encodeSegment(id)/`，取最高 generation，只解 zstd 第 1 帧 | B：index.js:3056/3452/3514 |
| 2 | 如何定所属工作区 | `dsh-workspace` 注册表按 `realpath(header.cwd)` 分组；缺失路径 → 未分组（或留在旧记录） | B：dsh-workspace:371/758/879 |
| 3 | 如何恢复 cwd | 投影 `init=header.cwd`，逐事件 apply `working-directory/change`；缺失时 `defaultDirectory` | B：dsh-working-directory:35-41/81 |
| 4 | 旧路径不存在 | 发现/读取正常；分组丢失；**所有模型回合被 `ensure` 拒绝** | B/C：dsh-working-directory:91-105 + README |
| 5 | 不修改内容可否重映射 | 可以：追加 `working-directory/change`（append-only 正常写面），历史字节零改动 | B：index.js:121-138 |
| 6 | 有无受支持 API | 有：`workingDirectory.set` / SDK `session/working-directory/set`；无 header 改写/目录迁移 API | B：README + dsh-sdk-jsonrpc-server:651 |
| 7 | 最小重写范围 | 仅 header 帧（第 1 帧）替换 + 移动 project 目录；事件帧不动 | B：index.js:3279/3476 |
| 8 | 重写后一致性 | 校验和随帧重算；id 不变；projectKey 按新 cwd 重算并搬目录；无 DB 索引需同步 | B：index.js:1296/880/3476 |
| 9 | 更安全的方案 | R（追加 change 事件）优于 W（surgical）优于 P（重建旧目录） | B/C |
| 10 | 长期最优 | R；W 作文档化应急；向上游要 relocate API（D） | 分析 |

## 7. 停止条件核对

- 本轮未修改任何产品源码、未修改任何历史会话、未安装/生成新 Runtime（`npm ci` 只恢复了 `app/package.json` pinned 依赖用于阅读，不产生新代码）、未连接真实模型、未碰真实用户数据、未改动 appId/NSIS GUID/PRODUCT_NAME/数据目录。
- **存在受支持的安全转换方案（R），因此不触发"无受支持方案"的强制停止条款；且本轮未做任何 zstd 帧头/校验/格式手术**（W 仅作文档化备选，未实现、未执行）。
- 静态源码推断（B/C 级）已全部与运行时事实（A 级）区分标注；没有任何"实际恢复成功"的表述。

## 附录：本审计引用的源码位置（均在本仓库 worktree 内可读）

| 文件 | 关键行 |
|---|---|
| `app/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js` | 791-845 header 键/守卫；858 encodeSegment；880 projectKey；907-943 路径推导；1296 校验和选项；1310 scanZstdFrames；2607 list；3056 listGenerations；3110 listArtifacts；3146 readGenerationHeader；3180/3476 assertStoredIdentity；3279 encodeMaterialization；3452 findLog；3514 listProjectDirs |
| `app/node_modules/@deepseek-ai/dsh-session-format-catalog/lib/index.js` | 41 currentVersion: 4 |
| `app/node_modules/@deepseek-ai/dsh-workspace/lib/index.js` | 109 attachSession；371 init；376 candidateMatches；758 bootstrap；879 indexHeader；905 reportFilteredCandidates |
| `app/node_modules/@deepseek-ai/dsh-working-directory/lib/index.js` | 27 defaultDirectory；35-41 projection init/apply；81 get；91 ensure；121 set；138 commit |
| `app/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml` | 138-141 session root = `dshHomePath('sessions')`；166-170 working-directory 挂载 |
| `app/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js` | 181 resolveAgent；304 resumeObserved；334/355 cwd 冲突；424 createAgent（mkdir cwd） |
| `app/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js` | 1410 restoreOrCreateConfigured；1716 resumeWith |
| `app/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-server/lib/index.js` | 641/651 get/setWorkingDirectory |
| `app/src/import.mjs` | 21 LEFT_BEHIND；218 newerSessions；312 importTeam；335-337 delete workspaceId；369-376 summary 字段 |
| `app/src/first-run.mjs:60` | 默认 dataDir `~/.ds-bot`、workspace `~/DS Bot` |
| `app/src/main.mjs:587` | `DS_BOT_WORKSPACE` 传 team 工作区路径 |
| `ds-bot/src/host/roster.js:54` | `ensureWorkspace` → `workspaceRegistry.create` |
| `ds-bot/src/host/folders.js:24/120` | teamFolder / setTeamWorkspace |
| `app/test/host-process.test.mjs:47` | "corrupt session log … and cwd identify …" 错误文案的现网测试锚点 |
