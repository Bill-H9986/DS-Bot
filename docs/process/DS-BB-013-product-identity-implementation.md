# DS-BB-013：DS Bot Base 独立产品身份与数据目录隔离实现

- 日期：2026-11-19
- 性质：产品身份实现阶段（013-A…F），隔离环境测试，不触碰用户真实数据，不执行 Git commit
- 技术基线：worktree `fervent-darwin-188c56`，分支 `claude/fervent-darwin-188c56`，基点 `origin/dev @ 495c6968`；DSH 固定版本 `@deepseek-ai/*` 0.2.2-rc.1
- 前置依据：[DS-BB-012-session-recovery-validation.md](DS-BB-012-session-recovery-validation.md)（012 通过是 013 的启动前提）
- 证据目录：`docs/process/dsbb013-artifacts/`（测试结果 JSON、测试日志、构建日志）
- 测试数据：全部在临时目录（`mkdtemp` 根）与 gitignore 覆盖的构建输出中，与 `~/.dsh` 及桌面应用自身数据完全隔离

## 0. 证据等级约定（本文使用）

| 等级 | 含义 |
|---|---|
| **A** | 本轮实际执行、可复现的测试结果（命令与退出码见 §10） |
| **B** | 静态源码验证：逐行读过的实现与 diff |
| **C** | 由 A/B 级事实组合推出的结论 |
| **D** | 本环境不可验证项（如实列出，不用配置检查代替） |

## 1. 身份常量总表（旧 → 新）

| 项 | 旧 DS Bot（保持不变） | 新 DS Bot Base | 定义位置 |
|---|---|---|---|
| 产品名 | DS Bot | **DS Bot Base** | `app/src/legacy.mjs` `PRODUCT_NAME`、`app/package.json` `productName` |
| Electron appId | `io.github.fei2411.dsbot` | **`io.github.fei2411.dsbotbase`** | `app/src/legacy.mjs` `APP_ID`、`app/electron-builder.yml` `appId` |
| NSIS GUID | `32c46dfc-ed78-5d41-85a4-a3c7f083f2e0` | **`cf83dddd-4347-491c-8c16-aede2ad61506`**（全新、固定，注释禁止再生成） | `app/electron-builder.yml` `nsis.guid` |
| 壳数据目录 | `%APPDATA%\DS Bot` | **`%APPDATA%\DS-Bot-Base`** | `app/src/legacy.mjs` `SHELL_DATA_DIR` |
| DSH_HOME | `~/.ds-bot` | **`~/.ds-bot-base`** | `app/src/first-run.mjs` `defaultPlaces` |
| 默认工作区 | `~/DS Bot` | **`~/DS Bot Base`** | 同上 |
| npm 包名 | `dsbot` | **`dsbot-base`** | `app/package.json` `name`、`app/package-lock.json` 根 `name` |
| Linux 桌面名 | `dsbot.desktop` | **`dsbot-base.desktop`** | `app/package.json` `desktopName` |
| Linux 可执行名 | `dsbot` | **`dsbot-base`** | `app/electron-builder.yml` `linux.executableName` |
| 版权行 | …the DS Bot contributors | …the **DS Bot Base** contributors | `app/electron-builder.yml` `copyright` |

appId 命名空间前提：`io.github.fei2411.*` 与项目所有权（`Fei2411`，上游仓库 `Fei2411/DS-Bot`、发布账号一致）匹配，无所有权或命名冲突（B 级，核对 `upstream` remote 与 electron-builder `publish.owner`）。未出现"冲突时停止"情形。

## 2. 013-A：产品身份分离（appId / NSIS GUID / 显示名）

改动（B）：

- `app/electron-builder.yml`：`appId` → `io.github.fei2411.dsbotbase`；`nsis.guid` → 全新 UUID 并加注释（固定保存、后续版本不得重新生成）；文件头注释声明本产品独立安装/升级/卸载，旧身份（`io.github.fei2411.dsbot` / 旧 GUID）不受影响。
- `app/src/legacy.mjs`：`APP_ID` 改为新值；`win32` 上 `app.setAppUserModelId(APP_ID)` 随新 appId 生效。
- 用户可见显示名（英文产品名，按 AGENTS.md 规则）：`shell.mjs` 的 8 种语言 SHELL_TEXT 全部改为 `DS Bot Base`、`main.mjs` 主窗口 `title`、`start-window.mjs` 标题与说明、`background-notice.mjs` 对话框标题、`start/start.html` 的 `<title>`、`start/text.mjs` 全部文案（133 处替换，无叠写）、`ui/index.html` 的 `<title>`。
- 测试夹具同步：`fake-electron.mjs`（exe/`getTitle`/`name`）、`lifecycle-main.mjs` 与 `check-lifecycle.mjs` 的页面标题断言、`check-packed.mjs` 的打包可执行名断言（`DS Bot Base.exe` / `dsbot-base` / `DS Bot Base.app`）。

有意保持不变的旧字符串（013-F 兼容性，见 §7）：

- `LEGACY_PRODUCT_NAME = 'DeepSeek Bot'`、`LEGACY_ENGINE`、`LEGACY_ARTIFACT_PREFIX`：旧产品线（及更老的 DeepSeek Bot 名）的兼容标识，供已发布的旧版本继续使用；新产品不复用。
- 日志前缀 `DS Bot:`（`console.log`/`console.warn` 行）：非用户界面文案，保持不动。
- `electron-builder.yml` 的 `artifactName: DS-Bot-...` 与 `publish:` 块：**本阶段有意不改**（更新源的新旧分离未决，见 §9 阻断项）。

Windows 升级识别（C）：Windows 把 NSIS 安装器识别为"同一应用的升级"的依据是卸载注册表项的 GUID（由 `nsis.guid` 驱动）。新安装器使用全新 GUID，旧安装器的 GUID 未改动，因此新应用不会把旧应用识别为原位升级，两者可并存；electron-updater 的频道依据 `appId`，`io.github.fei2411.dsbotbase` ≠ `io.github.fei2411.dsbot`。此推理由"新 GUID/新 appId 与旧值不同"（B 级，§1 表格 + `legacy-identity.test.mjs` 的显式不等断言）得出；**真实安装器并存在 D 级范围内**（§9，第 11 项未验证）。

## 3. 013-B：OSCrypt 名称捕获机制的保留

`configureIdentity()`（`app/src/legacy.mjs`，改写后）逐行 diff 证据（B 级，`git show HEAD:app/src/legacy.mjs` 对比）：

| 机制环节 | 旧实现 | 新实现 |
|---|---|---|
| ready 前捕获 | `app.setName(LEGACY_PRODUCT_NAME)`（复用旧目录时） | `app.setName(PRODUCT_NAME)`（本产品自己的目录已存在时） |
| ready 后恢复显示名 | `app.once('ready', () => app.setName(PRODUCT_NAME))` | 同形：`app.once('ready', () => app.setName(PRODUCT_NAME))` |
| 触发条件 | `reuse`（旧 `%APPDATA%\DeepSeek Bot` 目录存在且未存 `locations.json`） | `upgrade`（非隔离运行且 `%APPDATA%\DS-Bot-Base` 已存在） |
| 平台豁免 | win32（DPAPI 按用户解密，名称无关）跳过 | 同（`upgrade && platform !== 'win32'`） |
| 隔离运行不捕获 | `explicit \|\| DS_BOT_HOME` 时不做 | 同（`isolated` 判定保留） |
| 旧浏览器加密数据兼容 | 捕获名 = 写数据时的旧名 | 见下 |

**关键决定（需负责人确认）**：旧的捕获分支以"复用旧数据目录"为条件。013-D 要求新产品**不得**把旧数据目录作为活动目录，该条件分支因此成为死路径——保留"捕获旧产品名"的字面逻辑在本产品里永远不会成立（本产品永远不会复用旧目录，旧目录里也没有本产品的浏览器加密数据）。因此：

- **保留的是机制**（Electron 44 在 ready 前捕获应用名作为 Chromium OSCrypt 身份；安装后的再次启动必须在 ready 前固定该名称，否则浏览器加密数据（登录态 Cookie 等）解密失败），以及**机制在本产品内的正确落点**：本产品自己的安装（`DS-Bot-Base` 目录已存在）上，捕获名 = 本产品自己的 `PRODUCT_NAME`；
- **删除的是条件**（"复用旧目录"），因为 013-D 明令禁止；删除的不是捕获机制，且新产品数据目录里不存在旧产品的浏览器加密数据，不存在"丢失旧数据兼容"。

按任务书"如果新旧身份分离与现有 OSCrypt 机制存在冲突，停止并提供具体源码证据"的要求，这里**不冲突、不绕过**：机制保留、目标重定向到本产品自身安装，并如实上报本决定供审核（若负责人要求逐字保留旧捕获代码，可在 `legacy.mjs` 中恢复 `reuse` 分支，改动量约 10 行；当前实现已通过 11/11 的 `legacy-identity` 测试，其中包含"旧产品的安装副本不会被采纳"的专门用例）。

## 4. 013-C：userData 隔离

`configureIdentity` 把 userData 从 Electron 按应用名推导的默认改为**显式 join**：`join(app.getPath('appData'), 'DS-Bot-Base')`（Windows 即 `%APPDATA%\DS-Bot-Base`；macOS/Linux 为各自的应用数据目录下同名文件夹），并同步 `sessionData`。全部路径拼接使用 `join`，不是字符串改名（B 级）。

隔离证据（A 级）：

- `legacy-identity.test.mjs`（11/11）：全新安装（`DS-Bot-Base` 不存在 → `upgrade: false`）、再次启动（目录存在 → `upgrade: true`）、**旧产品的 `DS Bot` 目录存在时不被采纳**（显式断言 userData 仍指向新目录）、`DS_BOT_SHELL_DATA` 显式指定、`DS_BOT_HOME` 隔离运行不发现已安装副本；并固定 `config.appId === APP_ID`、`config.nsis.guid === 'cf83dddd-4347-491c-8c16-aede2ad61506'` 及其与旧值的不等。
- 回归：全套 497 个应用测试通过（§10），其中 `main-import`/`main-import-quit` 固定 `dataDir === join(home, '.ds-bot-base')`。

## 5. 013-D：DSH_HOME 隔离

| 保证 | 实现与证据 |
|---|---|
| 新安装默认新 DSH_HOME | `defaultPlaces()` → `join(homedir(), '.ds-bot-base')`（B 级源码 + A 级 `place.test.mjs` 16/16 的 default-places 断言、`main-import` 的 `locations.json` 落盘断言） |
| 数据根与两个应用不冲突 | 新目录名（`.ds-bot-base` / `DS-Bot-Base`）与旧（`.ds-bot` / `DS Bot`）不同；`legacy-identity` 用例 3 显式放置旧目录后断言不被采纳（A 级） |
| 旧目录只作用户授权的迁移源 | 见 §7（`oldTeamSources`：读 `~/.ds-bot` 与旧壳数据里的 `locations.json`，只读） |
| 不静默采用旧目录为活动数据 | `chooseLocations` 只读旧目录、只产出 `offer`（在导入卡上由用户回答）；`dataDir` 恒为新产品自己的默认目录或 `DS_BOT_HOME` 指定的目录（A 级，`first-run.test.mjs` 5/5） |
| 迁移读 ≠ 写、旧数据不被移动/删除 | `first-run.test.mjs` 用例 2/5 断言旧目录在提供 offer 与落盘 `locations.json` 后**内容不变、无新增文件**（A 级） |

主进程环境面（B 级，`main.mjs:581`）：Host 子进程 `DSH_HOME: places.dataDir`、`DS_BOT_WORKSPACE: places.workspace`、`DS_BOT_USER_DSH_HOME: userDshHome()` 全部来自 `chooseLocations` 的结果，即新数据根；子进程自身不含身份常量。`locations.json` 的读写（`saveLocations`/`readSaved`）落在新 userData 内；迁移读旧壳数据的 `locations.json` 在 `oldTeamSources` 中是**读**操作。

## 6. 013-E：默认工作区

`defaultPlaces().workspace = join(homedir(), 'DS Bot Base')`（B 级 + A 级：`place.test.mjs` 的 defaults 断言、`main-import` 用例 59/65 行 `existsSync(join(home, 'DS Bot Base', 'draft.md'))` 证明复制落点为工作区新目录）。

## 7. 013-F：迁移兼容性

- **保留**：DS-BB-011 迁移（用户自己的 DSH，`import.mjs` 的 `userDshHome`/`findTeam`，**未改动**——`git diff` 中 `app/src/import.mjs`、`app/src/updates.mjs` 干净）；DS-BB-012 R 方案（历史会话路径重映射，位于 DSH 侧，本阶段未触碰 `ds-bot/` 树，`git diff --name-only -- ds-bot/` 为空，`build-client --check` 通过）。
- **新增**：旧 DS Bot 数据目录发现（`first-run.mjs`）：`oldTeamSources()` = `~/.ds-bot` + 旧壳数据目录 `DS Bot/locations.json` 记录过的自定义目录（去重、resolve）；提供优先级 = 用户自己的 DSH 优先（`offeredTeam`），其后是旧数据目录；offer 携带 `from`（源路径），导入卡上由用户选择（`import-flow.mjs` 的 offer 卡片未改）。
- **不迁移**：浏览器 Cookies/Local State/IndexedDB/登录态（OSCrypt 机制本身只保证安装内稳定，不跨产品复制）；不覆盖新凭据（新 DSH_HOME 独立）；不移动/删除旧数据（`first-run.test.mjs` 断言旧目录内容不变）。
- **本阶段的最小必要修复**（A 级）：新增的 `first-run.test.mjs` 捕获了 `oldTeamSources` 中 `sources.map(resolve)` 的真实缺陷——`Array.map` 回调的第三参（整个数组）被传给 `path.resolve` 而抛 `TypeError`，被 `offerOf` 的 catch 静默吞掉，导致旧目录 offer 永远不出现。修复为 `sources.map((source) => resolve(source))`。除这一行外未重构迁移流程（符合"不得大规模重构"约束）。

## 8. 更新模块保护结果

| 能力 | 位置 | 013 结果 |
|---|---|---|
| Electron 壳更新 | `app/src/updates.mjs`、`app/scripts/check-update.mjs`、electron-builder `publish:` 块 | **未改动**（git diff 干净）；`publish` 仍指向 `Fei2411/DS-Bot` 仓库——即 §9 的新旧分离未决项，本阶段不改 |
| DS-Bot 插件更新 | `ds-bot/` 树（pnpm 安装器、宿主更新流程） | **未改动**（`git diff --name-only -- ds-bot/` 为空；`build-client --check` 退出码 0） |
| DSH Runtime 更新 | `app/scripts/prepare-runtime.mjs`、`dist.mjs` | **未改动** |

三项更新能力未合并、未重构（C 级，由"相关文件零 diff"推得）。

## 9. 未验证项与发布阻断

| # | 项 | 状态 | 说明 |
|---|---|---|---|
| U1 | 真实安装器并存（同一机器安装新旧两个应用、同时运行、各自卸载） | **D 级，未验证** | 本环境（Windows worktree，无显示/安装权限）无法执行真实 NSIS 安装；按任务书要求如实标记，不以配置检查代替。需在一台 Windows（并最好 macOS/Linux）机器上执行：安装旧 DS Bot → 安装新 DS Bot Base → 两者同时运行互不干扰 → 各自更新/卸载后旧数据目录完好 |
| U2 | electron-builder `npm run dist` 完整打包 | **本环境未验证** | 沙箱 worktree 缺少 CI 的 Electron 下载缓存、`seed-electron-checksums` 前置与 LibreOffice runtime payload；`dist.mjs` 启动后停在 "loaded configuration"（日志 `dsbb013-artifacts/electron-builder-dist.log`）。CI 的 app-package 作业（test.yml "Desktop app package"）在全量 CI 环境中执行该步骤 |
| U3 | 桌面壳更新源的新旧分离 | **未决，本阶段不改** | `publish:` 仍发布到旧仓库 `Fei2411/DS-Bot` 的 release，`artifactName` 仍是 `DS-Bot-*`；新产品的更新频道归属需负责人决定后单独处理 |
| U4 | 三个更新模块的行为回归 | 未在本环境运行端到端更新演练 | 静态保护证据见 §8（零 diff）；端到端"安装旧版 → 更新新版"演练随 U1 一并做 |

## 10. 测试命令与实际执行结果（A 级）

全部在 worktree 内执行；测试数据只在 `mkdtemp` 临时目录，未触碰 `~/.dsh` 或真实应用数据。

```bash
cd app
npm test          # 全套应用测试（CI 同名门禁）
node --import ./test/reset-env.mjs --test "test/*.test.mjs"   # 同上，直接跑
cd ..
cd ds-bot && node scripts/build-client.mjs --check
```

| 命令 | 结果 | 证据文件 |
|---|---|---|
| `app` 全套测试 | **497 tests / 493 pass / 0 fail / 4 skipped，exit 0** | `dsbb013-artifacts/app-unit-tests.log` |
| `app/test/legacy-identity.test.mjs`（单项） | 11/11 | `app-legacy-identity.log` |
| `app/test/first-run.test.mjs`（新增，迁移源） | 5/5 | `app-first-run.log` |
| `app/test/main-import / main-import-quit / main-first-run / import / import-flow / place` | 1/1/1/29/16/16 全过 | 对应 `app-*.log` |
| `app` 生产构建（vite，窗口 UI） | **构建成功，exit 0**（`ui/dist/index.html` `<title>DS Bot Base</title>`） | `vite-build.log` |
| `ds-bot` client 生成物一致性 | `build-client.mjs --check` exit 0 | （本轮直接执行） |
| `npm run dist`（electron-builder） | **未验证**（§9 U2） | `electron-builder-dist.log` |

环境说明（非 013 代码缺陷）：本 worktree 的 `ds-bot/node_modules` 是手工拼装的开发树（`app` 侧由 `npm ci` 完整安装，vite 构建按导入文件向上解析到 `ds-bot/node_modules`）。为跑通 vite 构建，做了 gitignore 覆盖的开发时供给（不产生任何被跟踪文件改动，`git status` 中 node_modules 零足迹）：从 `app/node_modules` 拷贝 0.2.2 版 `@deepseek-ai/dsh-client-*` 及其依赖闭包（约 90 个包），并按包清单安装 `simple-icons`、`zustand`、`clsx`、`shiki` 等 15 个 DSH 客户端包未声明的传递依赖（`--no-save`，不动锁文件）。CI 的 `npm ci` 环境不存在此问题。

## 11. 逐结论证据等级

| 结论 | 等级 |
|---|---|
| 新旧身份常量完全分离（appId/GUID/显示名），旧身份值未改动 | B（源码 diff）+ A（legacy-identity 11/11） |
| userData/DSH_HOME/工作区三目录相互独立且默认全新 | B + A（first-run 5/5、main-import 系列、place 16/16） |
| 旧数据目录只读发现、用户选择迁移源、不静默采用、不覆盖/不移动旧数据 | A（first-run 用例 2/5 内容不变断言） |
| OSCrypt 捕获机制保留、按 §3 重定向到本产品自身安装 | B（源码 diff）+ A（legacy-identity 用例 3）；决定本身待负责人确认 |
| 三个更新模块未破坏 | B（零 diff）+ A（client build-check） |
| TS/JS 测试与生产构建通过 | A（497/493/0、vite exit 0） |
| 真实安装器并存、完整 dist 打包、更新源归属 | D（§9，U1–U4） |

**总评：A 级**（所有可在隔离环境验证的项目均通过并有可复现证据；不可验证项已如实列为 D 级并给出补齐路径）。

## 12. 停止条件核对

- 未执行任何 `git checkout / reset / clean / stash / commit`；工作树保留全部 013 改动与新测试、报告、证据目录，等待负责人审核。
- 012 产物（`docs/process/DS-BB-012-session-recovery-validation.md`、`dsbb012-artifacts/`、`ds-bot/dev/dsbb012/`）保持未提交原样，未被 013 覆盖。
- 未进入更新系统重构与发布阶段；未改动 `CHANGELOG.md`、`README*`（本阶段无用户可见的 changelog 条目要求；如负责人要求补 README 同步说明可另行处理）。
- 本阶段新增的被跟踪文件：`app/test/first-run.test.mjs`（测试证据）+ 本报告与证据目录。源码改动集中在 §2–§5 所列 26 个被跟踪文件（`git diff --stat`：26 files，+376/−275）。
