# DSH 桌面端移植 Windows 7 SP1 —— 可行性分析与实施方案

分析基线：`deepseek-harness-master`（上游 0.2.0-rc.2，commit 639ed015）、`dsh-desktop-master`（桌面 2.0.17 / Next 2.0.17-next）
本机环境：VS2019 Enterprise 16.11.31（`D:\Microsoft Visual Studio\2019\Enterprise`）、Qt 5.11.2 / 5.13.1 / 5.15.2（msvc2019_64 在位）、Node 24.13.0

---

## 一、结论

目标表述为「改配置让现有 dsh 跑在 Win7 SP1」，实际跨越了三个已终结的技术代际。判定如下：

1. **现状发行的 dsh 在 Win7 SP1 上启动即失败**，且有两道彼此独立的关卡：其运行时 `node.exe` 24.21.0 静态导入 `GetSystemTimePreciseAsFileTime`（Windows 8 起引入），在**加载期**就断；即便越过这一关，Node 14 起内置的 `IsWindows8OrGreater()` **启动期**检查也会主动退出（真机已复现，见 §2.1）。
2. **不存在「改几行配置」的移植路径**。需要同时替换浏览器内核、Node 运行时、前端样式体系、SQLite 内置模块、多个 Windows 专有子系统。
3. **存在一条工程量可控、可验证的落地路径**：Electron 降到 22.3.x（其 fork 的 Node 已移除平台检查，二进制在 Win7 上零开关可用），前端降到 Chromium 108 目标，后端降到 Node 16.17.1 或 18.20.8。这条路径保留全部核心功能，代价约 **60～100 人日**。
4. **Qt5 / VS2019 在主线方案里只有两处真实用途**：编译 Node 原生模块到目标 ABI、构建 NSIS 安装器的原生组件。Qt 本身不是必需项（详见 §6）。

---

## 二、三条硬天花板（全部为实测证据）

### 2.1 Node 运行时：上限 18.20.8

用 VS2019 `dumpbin /imports` 直接读各版本官方 `node.exe` 的导入表：

| Node 版本 | GetSystemTimePreciseAsFileTime | WaitOnAddress / WakeByAddress | Win7 SP1 可运行 |
|---|---|---|---|
| 14.21.3 | 无 | 无 | 加载通过 |
| 16.17.1 | 无 | 无 | 加载通过 |
| **18.20.8** | **无** | 无 | **加载通过（最高候选）** |
| 20.19.5 | **有** | 无 | **加载即失败** |
| 22.20.0 | **有** | 无 | **加载即失败** |
| 24.21.0（dsh 在用） | **有** | 无 | **加载即失败** |

`GetSystemTimePreciseAsFileTime` 是 Windows 8 引入的 KERNEL32 导出，Win7 内核不具备。静态导入意味着**进程加载阶段就失败**，环境变量一类的开关绕不过。

**但加载期不是唯一的关卡 —— 还有一道启动期关卡（2026-02 真机实测补充）**：

在 Win7 真机运行 `node-v18.20.8-win-x64\node.exe`，实际输出：

```
Node.js is only supported on Windows 8.1, Windows Server 2012 R2, or higher.
Setting the NODE_SKIP_PLATFORM_CHECK environment variable to 1 skips this
check, but Node.js might not execute correctly. Any issues encountered on
unsupported platforms will not be fixed.
```

进程随即退出（未进入 REPL）。这是 Node 主动植入的 `IsWindows8OrGreater()` 检查，不是加载失败 —— **能打印这段文字，本身就证明 Node 18 的 PE 已成功加载、C 运行时已初始化**。

复核全部候选二进制后，得到精确的三段式判据：

| 运行时 | 加载期（静态导入） | 启动期（平台检查） | Win7 结论 |
|---|---|---|---|
| Node 14.21.3 | 通过 | 文案同为 "Windows 8.1"，即检查条件同为 `IsWindows8OrGreater()` | 需 `NODE_SKIP_PLATFORM_CHECK=1` |
| Node 16.17.1 | 通过 | 同上 | 需 `NODE_SKIP_PLATFORM_CHECK=1` |
| **Node 18.20.8** | **通过** | 同上 | **需 `NODE_SKIP_PLATFORM_CHECK=1`，天花板候选** |
| Node 20 / 22 / 24 | **失败** | — | 无解，加载期即断 |
| **Electron 22.3.27** | **通过**（`electron.exe` 无任何 Win8+ 专有导入） | **不存在该检查**（Electron 的 Node fork 已移除 `NODE_SKIP_PLATFORM_CHECK` 与警告文案，二进制内检索为空） | **直接可用** |

两个关键推论：

1. **Node 14 与 Node 16 也带同一道检查**，文案与 18 完全一致。所谓"Node 14 原生支持 Win7"在官方发行二进制上并不成立，同样需要跳过变量。
2. **Electron 22 是唯一在 Win7 上"零开关可用"的运行时** —— 它的二进制里连平台检查代码都不存在。这才是 Electron 22 官方支持 Win7 的真实机制。

因此结论修正为：**Win7 SP1 上的 Node 上限是 18.20.8，前提是设置 `NODE_SKIP_PLATFORM_CHECK=1`；而 Electron 22 不需要任何前提。** dsh 声明的 `engines: "^22.19.0 || >=24.0.0"` 与之一致地相差 4 个大版本。

### 2.1.1 待实测确认项

`NODE_SKIP_PLATFORM_CHECK=1` 只是放行检查，警告文案自身声明了 "might not execute correctly"。Node 18.20.8 的静态导入干净，但 V8 可能在运行期通过 `GetProcAddress` 探测 `WaitOnAddress` 一类 Win8+ 接口。真机验证命令见 §8 步骤 1，必须跑到能正常执行 JS 才能确认该路径成立。

### 2.2 浏览器内核：上限 Chromium 109

- Electron 23 起基于 Chromium 110，官方终止 Win7/8/8.1 支持；**Electron 22 分支（22.3.x）是最后一个支持 Win7 的版本**，内置 Chromium 108 + Node 16.17.1。
- 独立浏览器侧：Chrome 109、Firefox ESR 115 是各自产品线最后支持 Win7 的版本。

dsh 当前用 Electron 44.0.0（`dsh-plugin-desktop` 与 `dsh-desktop-next` 的 devDependencies 均为 `"electron": "44.0.0"`），差距 22 个大版本。

### 2.3 外部工具链天花板

| 组件 | dsh 现值 | Win7 SP1 上限 | 说明 |
|---|---|---|---|
| Python | 3.12.14 | 3.9 | Python 3.10+ 官方终止 Win7 |
| PowerShell | pwsh 7 | powershell.exe 5.1（需装 WMF 5.1） | PowerShell 7 不支持 Win7 |
| ripgrep | 现包 `rg.exe` | 13.x | 现包 `rg.exe` 导入 `api-ms-win-core-synch-l1-2-0` 的 `WaitOnAddress`/`WakeByAddressAll`/`WakeByAddressSingle`（Windows 8 起），加载即失败 |
| 终端 | node-pty + ConPTY | winpty 或降级 | ConPTY 自 Windows 10 1809 起提供，Win7 无此机制 |

---

## 三、代码兼容缺口量化

扫描范围：上游 6503 个 `.ts/.tsx/.js/.mjs/.json` 文件（剔除 `node_modules`、`dist`、`lib`），共 103.8 万行 TS。

### 3.1 后端（Node 22+ → Node 18.20.8，或选点 A1 的 Node 16.17.1）

下表命中数按目标运行时分层。选点 A2（Node 18.20.8）只需处理"Node 20+"列以上的项；选点 A1（Node 16.17.1）额外需要处理"Node 17/18 增量"分组。

| API / 语法 | 引入版本 | 命中数 | 处置难度 |
|---|---|---|---|
| `Promise.withResolvers` | Node 22 | 1914 | 低 — 单行运行时垫片 |
| `import.meta.dirname` | Node 20.11 | 243 | 低 — 构建期 define 注入 |
| `using` / `await using` 声明 | V8 12.9（Node 22+） | **128** | **高 — 语法级，构建链不具备降级能力** |
| `fs.glob` / `globSync` | Node 22 | 107 | 中 — 运行时垫片（glob 包） |
| `AbortSignal.any` | Node 20.3 | 91 | 低 — 垫片 |
| `process.execve` | Node 22.15 | 54 | 中 — 需替代实现 |
| `navigator` 全局 | Node 21 | 54 | 低 — 垫片 |
| `import.meta.filename` | Node 21 | 42 | 低 — 构建期注入 |
| `WebSocket` 全局 | Node 22 | 27 | 低 — 垫片（undici / ws） |
| `.toSorted` / `.toReversed` / `.with` | Node 20 | 27 | 低 — 原型垫片 |
| **`node:sqlite`** | Node 22.5 | **18** | **高 — 内置模块，垫片不可行** |
| `process.getBuiltinModule` | Node 22.3 | 10 | 低 — 垫片 |
| `Object.groupBy` / `URL.parse` / `toWellFormed` / RegExp `v` | Node 20-21 | 7 | 低 — 手改 |

**Node 16.17.1 增量分组**（仅选点 A1 需要）：

| API | 引入版本 | 命中数 | 处置 |
|---|---|---|---|
| 全局 `fetch` / `Request` / `Response` / `Headers` | Node 18 | 253 | 低 — 用 undici 注入全局 |
| `structuredClone` | Node 17 | 195 | 低 — 垫片（`v8.serialize` 往返或 `@ungap/structured-clone`） |
| `Array.prototype.findLast` / `findLastIndex` | Node 18 | 149 | 低 — 原型垫片 |
| `AbortSignal.timeout` | Node 17.3 | 57 | 低 — 垫片 |
| `.at()` | Node 16.6 | 855 | 无需处置（Node 16.17.1 已具备） |

**关键判断**：约 2500 处命中点属于「一次性垫片可覆盖」类别（运行时 polyfill + 构建期 define），真正的障碍只有两类：

1. **`using` 声明 128 处**（生产代码约 40 处，其余在测试）。esbuild / tsdown / TS 6 的 `target: node18` 均不会把显式资源管理语法降级。处置方式：写 TypeScript/Babel transformer 把 `using x = expr` 改写为 `const x = expr` + 显式 dispose，或手工改写这 40 处生产代码。测试代码可整体排除出打包范围。
2. **`node:sqlite` 18 处**，集中在 `packages/storage/storage-sqlite` 与 `packages/session-query/session-query-sqlite` 两个包。Node 16 / 18 均无此内置模块，需要落到 `better-sqlite3`（原生模块，须编译到目标 ABI —— Node 16.17.1 为 93，Node 18.20.8 为 108）或 `node-sqlite3-wasm`（纯 WASM，零编译负担，首推）。

### 3.2 前端（现代基线 → Chromium 108）

| 特性 | 最低 Chromium | 命中数 | Chromium 108 可用 |
|---|---|---|---|
| `color-mix()` | 111 | 90 | 否 |
| `:has()` | 105 | 79 | 是 |
| `popover` 属性 | 114 | 40 | 否 |
| CSS `anchor()` | 125 | 21 | 否 |
| 嵌套 `&:` | 112 | 51 | 构建期可编译，是 |
| `@container` | 105 | 9 | 是 |
| `@property` | 85 | 4 | 是 |
| `field-sizing` | 123 | 4 | 否 |
| `light-dark()` | 123 | 2 | 否 |
| `@starting-style` | 117 | 2 | 否 |
| `oklch()` | 111 | 1 | 否 |
| Tailwind CSS | **v4 要求 Chrome 111+** | 全站 | 否，需降 v3.4 |

前端栈：Vite 8.2.1 + React 18.3.1 + Tailwind v4 + shiki 4 + Base UI + lucide + sonner。降级工作 = Tailwind v4 → v3.4 迁移（CSS-first `@theme` → `tailwind.config.js`）+ 约 160 处 CSS 特性替换 + 构建 target 固定 `chrome108`。

### 3.3 桌面壳（Electron 44 → 22）

扫描 `dsh-desktop-master/src`（980 文件，约 4.8 万行）：

| 项 | 命中数 | 处置 |
|---|---|---|
| `WebContentsView`（Electron 30+） | 26 | 改回 `BrowserWindow` / `contentView` 组合 |
| `utilityProcess` | 6 | Electron 22 已具备，保留 |
| `withResolvers` / `import.meta.dirname` / `toSorted` / `structuredClone` | 35 | 走同一套 Node 垫片层 |
| `using` 声明 | 0 | 无负担 |
| `node:sqlite` / `fs.glob` / 全局 `WebSocket` | 0 | 无负担 |

桌面壳改造量明确且有限。

---

## 四、架构事实（方案支点）

读 `dsh-desktop-master/dsh-desktop-next/src/host-process.ts` 与 `deepseek-harness-master/apps/desktop-host/src/index.ts`，确认 dsh 桌面端为三层：

```
Electron 主进程（GUI 壳：窗口/托盘/菜单/更新）   apps/desktop/src/main.ts（67 KB）
        │ fork + IPC
        ▼
Host 子进程（跑完整 Web 应用，监听 127.0.0.1:19387）
        runProfile({ profile: 'desktop', args: ['--no-open','--port','19387'] })
        │
        ▼
React 前端（BrowserWindow 加载 http://127.0.0.1:19387）
```

关键代码（`apps/desktop-host/src/index.ts`）：

```ts
const application = runProfile({
  environment: loadLayeredEnv('dsh'),
  profile: 'desktop',
  resolvedProfile: { profile, installAnchor },
  patchFiles: [],
  args: ['--no-open', '--port', '19387'],
  ...(process.argv[5] === undefined ? {} : {
    packageManager: {
      command: process.execPath,              // ← 当前指向 Electron 二进制
      args: ['--expose-internals', process.argv[5]],
      env: { ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_NODE_EXECUTABLE: process.execPath, ... },
    },
  }),
})
```

三点决定方案走向：

1. **Host 与前端之间是 HTTP/WebSocket 边界**，不是 Electron 内部 API。后端可以被搬到任意节点。
2. Host 默认用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 启动，即跑在 Electron 内置 Node 里 —— **但这是可替换的**。dsh 安装目录本身就有独立运行时：`resources/runtime/primary-runtime/dependencies/node/bin/node.exe`（版本清单 `versions.json` 记的是 24.18.1）。3. 因此 **Electron 版本与后端 Node 版本没有运行时绑定关系** —— 这正是把二者分别降级到各自天花板（Chromium 108 / Node 18.20.8）的凭据。

---

## 五、方案

### 方案 A：单机原生（主攻目标）

```
Windows 7 SP1 x64
├── Electron 22.3.x（Chromium 108）         ← GUI 壳，需改 26 处 WebContentsView
│     ├─ BrowserWindow → http://127.0.0.1:PORT
│     │     前端：降级构建产物（target chrome108、Tailwind v3.4）
│     └─ 同一二进制的 Node 面（Node 16.17.1，无平台检查）
│           ELECTRON_RUN_AS_NODE=1 → 直接承载 dsh host
│           ├─ Node 20/22 API 垫片层（预加载）
│           ├─ using 声明 → 编译期转换
│           └─ node:sqlite → node-sqlite3-wasm
```

**后端运行时的两个选点（实测后新增的决策项）**：

| 选点 | 运行时 | 开关 | 后端垫片范围 | 架构 |
|---|---|---|---|---|
| **A1（推荐）** | Electron 22 内置 Node 16.17.1 | 无 | Node 22+ **及** Node 17/18 增量（`structuredClone` 195、全局 `fetch` 253、`findLast` 149、`AbortSignal.timeout` 57） | 保持原样（`process.execPath` + `ELECTRON_RUN_AS_NODE=1`） |
| A2 | 独立 `node.exe` 18.20.8 | `NODE_SKIP_PLATFORM_CHECK=1` | Node 22+ 增量 | 需改 `packageManager.command` 指向独立 node.exe |

A1 的优势是落在 Electron 官方支持范围内、架构零改动，代价仅是垫片层多覆盖约 650 处（全部属于纯 JS polyfill，可一次性注入）。A2 垫片更薄，但依赖一个官方声明"可能无法正确执行"的开关。**建议以 A1 为主攻，A2 作为 A1 在真机上受阻时的回退**。

功能保留度：核心 agent 循环、会话、工具调用、文件操作、Web UI 全部保留。
功能损失：内嵌终端（ConPTY 缺失）、语音输入（onnxruntime 待验证）、Office 引擎（Python 需降 3.9）、浏览器自动化（Chromium 版本约束）。

### 方案 B：瘦客户端（最小落地成本，A 的前置子集）

后端保持现状不动，跑在 Win10+ 机器（或同机 WSL2 / 虚拟机），Win7 只承载壳与前端。

- 改造量 = 方案 A 的**壳降级 + 前端降级**（约 15～25 人日）
- 后端零改动，功能 100% 保留
- 通道：`dsh web` 已提供 HTTP 服务，Win7 端连 `http://<后端主机>:19387`

方案 B 的全部产出在方案 A 里完全复用，属于零浪费的前置验证。建议按 B → A 顺序推进。

### 方案 C：零改造对照（用于快速验证链路）

Win7 上装 Chrome 109 或 Firefox ESR 115，直接访问部署在 Win10 机器上的 dsh web 服务。
不改任何代码，用来验证「前端在 Chromium 109 上到底有多少视觉/交互回归」，为方案 A/B 的前端降级清单提供实测依据。

### 方案取舍

| | 方案 A | 方案 B | 方案 C |
|---|---|---|---|
| 单机自包含 | 是 | 否 | 否 |
| 后端改造 | 约 40 人日 | 0 | 0 |
| 前端改造 | 约 15 人日 | 约 15 人日 | 0 |
| 壳改造 | 约 8 人日 | 约 8 人日 | 0 |
| 功能保留度 | 核心全保留，子系统降级 | 100% | 100% |
| 定位 | 最终形态 | 先落地 | 探路 |

补充路线（备选，仅在 Electron 22 EOL 风险不可接受时启用）：以 **CEF 109**（Chromium 最后一个支持 Win7 的版本）替代 Electron 22，宿主用 Qt 5.15.2 msvc2019_64 + QCefView 此类嵌入方案。此时 VS2019 + Qt5 才成为主线工具。代价是自建宿主工程，比 Electron 22 路线多约 30 人日。

---

## 六、实施路线

### 阶段 0：前置条件（必须先确认，1 人日）

- **Win7 必须是 64 位旗舰版 SP1**。`sharp-win32-x64`、`koffi-win32-x64`、`sherpa-onnx-win-x64`、`ripgrep-win32-x64` 均只有 x64 预编译产物，32 位 Win7 无对应依赖链。
- 系统补丁：KB2533623（`AddDllDirectory`）、KB4474419（SHA-2 签名）、KB2999226（UCRT）、KB3125574（便利汇总）。缺 KB2999226 时任何 MSVC 运行时依赖都会失败。
- 关闭 Win7 的 GPU 合成依赖：以 `--disable-gpu-sandbox --no-sandbox` 兜底（Chromium 在 Win7 上的 D3D11 路径不稳定）。

### 阶段 1：壳降级打通（3～5 人日）

1. `dsh-plugin-desktop` / `dsh-desktop-next` 的 `electron` 与 `electron-builder` 版本改为 22.3.x 分支。
2. 26 处 `WebContentsView` 改写为 Electron 22 可用的窗口组合。
3. `runProfile` 的 `packageManager.command` 从 `process.execPath` 改为**独立 node.exe 绝对路径**，断开壳与后端 Node 版本的绑定。
4. 验证：Win7 真机上 Electron 22 壳能起窗、能连上 19387 的 host。

### 阶段 2：前端降级（10～15 人日）

1. Tailwind v4 → v3.4 迁移（`@theme` → `tailwind.config.js`，插件链重排）。
2. 六类 CSS 特性替换：`color-mix()` 90 处 → 预计算色值；`popover` 40 处 → 自建浮层；`anchor()` 21 处 → JS 定位；`field-sizing` 4、`light-dark()` 2、`@starting-style` 2 → 等价手写；`oklch()` 1 → `rgb()`。
3. 构建 target 固定 `chrome108`（Vite 8 默认 target 已高于此）。
4. 验证：以方案 C 的 Chrome 109 作为对照基线，逐屏比对视觉与交互。

### 阶段 3：后端运行时降级（20～35 人日，按选点 A1 / A2 二选一）

先决条件：完成 §8 步骤 1，确定 A1（Node 16.17.1）还是 A2（Node 18.20.8）。

1. **垫片层**：新增一个预加载模块，注入 `Promise.withResolvers`、`AbortSignal.any`、`navigator`、全局 `WebSocket`（undici）、`fs.glob`（glob 包）、`process.getBuiltinModule`、`Array.prototype.toSorted/toReversed/with`。若走 A1，再叠加 `fetch` 全局、`structuredClone`、`findLast`/`findLastIndex`、`AbortSignal.timeout`。
2. **构建期注入**：`import.meta.dirname` / `import.meta.filename` 通过 tsdown/esbuild 的 define 或自定义插件替换，243 + 42 处全自动。
3. **`using` 转换**：定制 TypeScript transformer，把 `using x = expr` / `await using x = expr` 改写为等价的 `try/finally` + `Symbol.dispose` 调用。生产代码 40 处必须真转换（否则资源泄漏），测试代码 88 处可剔除出打包范围。
4. **SQLite 替换**：`storage-sqlite` 与 `session-query-sqlite` 两个包的 `node:sqlite` 依赖改为 `node-sqlite3-wasm`（免编译），保留相同的同步 API 语义。
5. **原生模块重编译**：`fs-ext`、`better-sqlite3`（若选此路）、`node-addon-require-builtin` 重编译到目标 ABI。用 VS2019 + node-gyp，A1 设 `npm_config_target=16.17.1`（ABI 93）、A2 设 `npm_config_target=18.20.8`（ABI 108）。
6. **ripgrep 替换**：`@vscode/ripgrep-win32-x64` 降到 13.x 产物，或改用纯 JS 搜索实现兜底。
7. **终端子系统**：`tool-pwsh-persistent` / `tool-bash-persistent` 在 Win7 上 fallback 到 `powershell.exe` 5.1；node-pty 的 ConPTY 路径在 Win7 上直接走降级分支（伪终端功能标记为不可用）。
8. 验证：构建产出在目标运行时下跑通启动自检与一轮完整 agent 对话。

### 阶段 4：打包与真机验收（8～12 人日）

1. electron-builder 产出 NSIS 安装包，`nsis.oneClick:false` 已配置；确认安装器脚本 `installer/*.nsh` 与 `window-frame.cpp` 在 VS2019 下构建通过（这里用到 VS2019）。
2. Win7 真机验收清单：冷启动、登录、多轮对话、文件读写、命令执行、崩溃恢复、卸载。
3. 明确标记不可用子系统并做 UI 降级（终端、语音、Office 导出、浏览器自动化）。

**合计：约 60～100 人日**（方案 B 约 15～25 人日）。

---

## 七、风险与代价

| 风险 | 影响 | 说明 |
|---|---|---|
| Electron 22 已 EOL | 高 | 22 分支最终版停留在 2023 年，Chromium 108 的已知漏洞不再获得修复。这是移植 Win7 的固有代价，不是实施缺陷。 |
| Node 18 已 EOL | 中 | Node 18 维护期已在 2025 年 4 月结束。与 Electron 22 同源。 |
| 平台检查绕过属非受支持路径 | 中 | 选点 A2 依赖 `NODE_SKIP_PLATFORM_CHECK=1`，官方声明该路径"可能无法正确执行"且不受支持。选点 A1（Electron 内置 Node）不含此风险，这也是 A1 被列为主攻的理由。 |
| 前端视觉回归 | 中 | Tailwind v4 → v3.4 与 160 处 CSS 特性替换会改变渲染细节，需以方案 C 建立对照基线。 |
| `using` 转换遗漏 | 中 | 资源释放语义若转换不完整，会表现为句柄泄漏 / 会话未释放。必须覆盖全部 40 处生产代码并有测试兜底。 |
| 子系统功能缺失 | 中 | 终端（ConPTY）、语音（onnxruntime 待验）、Office（Python 3.9）、浏览器自动化在 Win7 上属于不可恢复项，只能降级呈现。 |
| 上游跟进成本 | 中 | 上游发布 0.2.1+ 后，垫片层与 `using` 转换器需要同步回归。建议把改造做成独立补丁包而非直接改上游源码。 |

### 关于「其他的不动」

方案 A/B 能保证**功能语义等价**，但付出的代价是**代码级改动**：Electron 壳有 26 处 API 改写，前端有约 160 处 CSS 替换，后端有跨版本的运行时适配。这是把 2026 年的运行时栈压回 2011 年操作系统的必然成本。

### 关于 Qt5 与 VS2019 的真实定位

- **VS2019**：主线方案必需。用于编译 Node 原生模块到 Node 18 ABI、构建 NSIS 安装器原生组件、以及验证各预编译二进制。
- **Qt5**：主线方案（Electron 22）中无位置。它的价值在备选路线 —— CEF 109 + Qt 5.15.2（msvc2019_64）自建宿主。Qt 5.15 官方支持 Win7 SP1，是 Win7 上最"正当"的原生 GUI 框架。若最终不接受 Electron 22 的 EOL 风险，Qt5 + CEF 109 是替代路线。

---

## 八、立即可执行的验证实验

按顺序做，每步都有明确的通过 / 未通过判据。步骤 1 与 2 现在就能在 Win7 真机上跑（二进制已备好）。

### 步骤 1：确认 Node 18.20.8 在 Win7 上真能执行 JS（最高优先级）

```cmd
cd /d E:\Desktop\DSHV3\verify\n18\node-v18.20.8-win-x64
set NODE_SKIP_PLATFORM_CHECK=1
node.exe -e "console.log(process.version, process.arch, process.versions.v8); console.log([1,2,3].toSorted()); console.log(JSON.stringify(process.hrtime.bigint()))"
node.exe
```

- **通过**：打印版本与 `[1,2,3]`，并进入 `>` REPL 提示符。
- **未通过**：进程退出或 V8 报错 —— 说明内核层还依赖 Win8+ 动态接口，天花板下调到 Node 16.17.1，重复同一组命令。
- 附带价值：`process.versions.v8` 的输出决定 §3.1 里 `using` 转换器的目标语法级别。

若命令行 `node.exe` 进入 REPL 正常，再补一条长稳测试：

```cmd
node.exe -e "const t=setInterval(()=>{},100); setTimeout(()=>{clearInterval(t); console.log('timer-ok')},3000)"
```

### 步骤 2：确认 Electron 22.3.27 壳在 Win7 上可用

```cmd
cd /d E:\Desktop\DSHV3\verify\e22
electron.exe --version
```

预期打印 `v22.3.27`。随后在 `E:\Desktop\DSHV3\verify\e22\` 建一个最小的 `main.js`：

```js
const { app, BrowserWindow } = require('electron')
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 900, height: 600 })
  w.loadURL('data:text/html,<h1>Win7 shell ok</h1>')
})
```

运行 `electron.exe .`（需同目录有含 `main` 字段的 `package.json`）。能起窗渲染即确认壳路线畅通。

### 步骤 3：确认系统位数与补丁

```cmd
wmic os get osarchitecture
systeminfo | findstr /B /C:"OS Name" /C:"OS Version"
```

必须为 64 位。补丁清单见 §6 阶段 0；缺 KB2999226（UCRT）时任何 MSVC 运行时依赖都会失败。

### 步骤 4：方案 C 对照，产出前端回归清单

Win7 装 Chrome 109 或 Firefox ESR 115，访问部署在 Win10 主机上的 dsh web 服务：

```cmd
:: Win10 主机上
dsh web --port 19387 --host 0.0.0.0
```

逐屏记录视觉 / 交互异常，这份清单直接成为 §6 阶段 2 的降级工单。

### 步骤 5：从源码构建上游 0.2.0-rc.2

本机（Node 24.13.0 满足 `^22.19.0 || >=24.0.0`）：

```powershell
cd E:\Desktop\DSHV3\src\dsh-desktop-master
corepack yarn install --immutable
cd deepseek-harness
corepack pnpm install --frozen-lockfile
corepack pnpm run build
```

产出可构建是后续全部改造的前提。若 `deepseek-harness` 子模块目录为空（zip 分发不含 git submodule），需改用已解压的 `deepseek-harness-master` 并手工对齐 `upstream-reference.json` 记录的 commit `639ed015`。
