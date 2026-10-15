# DSH 桌面端 Windows 7 SP1 离线安装包 —— 最终方案 A

> 交付目标：一台**完全离线**的 Windows 7 SP1 x64 机器，双击单个 Setup.exe 安装完成，启动后即为完整可用的 DSH 桌面端。
> 本方案的全部技术判据来自对 Node.js 源码、Electron 发行二进制、DSH 源码树的直接检读，非推断。

---

## 0. 交付物

| 项 | 值 |
|---|---|
| 文件名 | `DSH-Desktop-<version>-x64-Win7-Setup.exe` |
| 形态 | NSIS 单文件安装包（`oneClick:false`、可选安装路径、创建桌面与开始菜单快捷方式） |
| 预期体积 | 350～450 MB（解包后约 1.0 GB） |
| 运行环境 | Windows 7 SP1 **x64**（必须是 64 位；`sharp`/`koffi`/`sherpa-onnx`/`ripgrep` 的预编译链只有 x64） |
| 网络要求 | 安装与核心功能全程离线；仅 LLM 推理与插件市场需要出网 |
| 附加产物 | `DSH-Desktop-<version>-x64-Win7-Portable.zip`（免安装绿色版，同一份 runtime） |

---

## 1. 方案确立依据

以下是决定本方案形态的关键实测结论，全部可复现。

### 1.1 Node 运行时的两道关卡

对官方 `node.exe` 直接读导入表与内嵌字符串：

| 运行时 | 加载期（静态导入 Win8+ API） | 启动期（平台检查） |
|---|---|---|
| Node 14.21.3 / 16.17.1 / 18.20.8 | 干净 | 存在 `IsWindows8OrGreater()` 检查，文案一致 |
| Node 20.19.5 / 22.20.0 / 24.21.0 | **含 `GetSystemTimePreciseAsFileTime`（Win8+）** | 同上 |
| Electron 22.3.27 | 干净 | **检查代码已被 Electron fork 移除** |

结论：**降级到 Node 18 这条路会把 DSH 拖进核心架构改造**。依据是 DSH 的插件解析机制建立在 Node 22/24 的内部模块之上：

```
packages/boot/app-boot/src/profile-resolution/resolver.ts:712
  installRuntimeInterception() → internalModules()          ← 无版本保护、无 try/catch
      → addon.requireBuiltin('internal/modules/esm/loader')
      → esmModule.getOrInitializeCascadedLoader()           ← Node 18 不具备该 API

vendor/loader/src/internal.ts:134
  if (major < 22) return                                     ← DSH 自述只支持 Node ≥22
```

`internalModules()` 被 `installRuntimeInterception()` 直接调用，而后者是 profile 解析的入口。Node 18 上该调用会抛出，DSH 启动阶段即断。**Node 降级路线被否决。**

### 1.2 Node 补丁面只有 2 处

对 Node 22.20.0 完整源码树（105 MB，含 `deps/v8`、`deps/uv`、`deps/openssl`）做全树检索：

```
GetSystemTimePreciseAsFileTime      → 1 处
IsWindows8Point1OrGreater           → 1 处（src/node_main.cc）
```

| 补丁 | 文件:行 | 改动 |
|---|---|---|
| 1 | `src/node_main.cc:38` | `IsWindows8Point1OrGreater()` → `IsWindows7SP1OrGreater()` |
| 2 | `deps/uv/src/win/util.c:443` | `GetSystemTimePreciseAsFileTime(&ft)` → `GetSystemTimeAsFileTime(&ft)` |

两处 API 签名完全一致（`void WINAPI f(LPFILETIME)`），`IsWindows7SP1OrGreater()` 由 `C:\Program Files (x86)\Windows Kits\10\Include\10.0.22000.0\um\VersionHelpers.h:106` 提供。

**这就是方案 A 的技术内核：不降级 Node，而是给 Node 打一个 2 行的 Win7 补丁并自编译。** 由此 DSH 后端 100 万行 TS **保持原样** —— `engines: "^22.19.0"` 满足、`using` 声明原生支持、`node:sqlite` 原生可用、Node internals 拦截机制完整保留。

### 1.3 原生模块零重编译

对 `app.asar.unpacked` 下全部 6 个 `.node` 二进制做导出符号检测：

```
conpty.node / conpty_console_list.node / sharp-win32-x64-0.35.5.node
koffi.node / win32-x64-msvc-napi-v9.node / sherpa-onnx.node
   → 全部导出 napi_register_module_v1 + node_api_module_get_api_version_v1
```

**全部为 N-API 模块，无一走 NAN/ABI 绑定。** N-API 跨 Node 版本 ABI 稳定，因此自编译的 Node 22 可直接复用现有全部预编译二进制，无需重编译、无需 electron-rebuild。

### 1.4 其他已定量结论

| 项 | 数据 | 处置 |
|---|---|---|
| `using` 声明 | 上游生产代码 40 处 | **实测 esbuild 可完整降级**（生成 `__using` helper + try/finally），但方案 A 不需要降级 |
| 前端 CSS | `color-mix()` 90、`popover` 40、`anchor()` 21、`field-sizing` 4、`light-dark()` 2、`@starting-style` 2、`oklch()` 1 | 需逐类降级 |
| Tailwind | v4（要求 Chrome 111+） | 降到 v3.4 |
| Electron 壳 | `WebContentsView` 26 处（Electron 30+ API） | 改写为 Electron 22 可用形态 |
| ripgrep | 现包导入 `api-ms-win-core-synch-l1-2-0`（Win8+） | 换 13.x 产物 |
| Python | 运行时内嵌 3.12.14（164.9 MB） | 降到 3.9（Office 技能链） |
| 终端 | node-pty 走 ConPTY（Win10 1809+） | Win7 上降级为 `powershell.exe` 5.1 路径，伪终端标记不可用 |

---

## 2. 目标架构

```
┌─ Windows 7 SP1 x64 ────────────────────────────────────────────────┐
│                                                                    │
│  Electron 22.3.27  (Chromium 108)                                  │
│    └─ BrowserWindow ──► http://127.0.0.1:19387                     │
│         前端：chrome108 目标构建产物（Tailwind v3.4）               │
│                                                                    │
│  node.exe  (自编译 Node 22.20.0 + 2 处 Win7 补丁)                   │
│    └─ ELECTRON_RUN_AS_NODE 或独立进程，承载 DSH Host                │
│         ├─ agent 核心 / 会话 / 工具链       ← 源码零改动            │
│         ├─ node:sqlite                      ← 原生可用              │
│         ├─ 全部 N-API 原生模块               ← 直接复用现有二进制     │
│         └─ 内嵌 Python 3.9 + pnpm           ← 离线自带              │
└────────────────────────────────────────────────────────────────────┘
```

关键支点（`apps/desktop-host/src/index.ts`）：Host 与前端之间是 HTTP/WebSocket 边界，且 Host 的启动命令可配置。原实现用 `process.execPath` 指向 Electron 二进制，本方案改为指向自编译的 `node.exe`，从而让「Chromium 108 的壳」与「Node 22 的后端」各自落在自己的能力上限上。

---

## 3. 三层改造

### 3.1 运行时层：Win7 兼容 Node 22（核心）

**产出**：`node.exe`（约 80 MB），部署到
`<install>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`

**补丁**：`patches/node-win7-sp1.patch`（2 文件 / 2 行）
**构建**：`scripts/build-node-win7.ps1`

脚本流程：前置检查 → 源码准备 → 施加补丁并做**全树残留复核** → `configure.py --release --dest-cpu=x64` → `vcbuild.bat release x64` → **dumpbin 导入表校验**（命中 `WaitOnAddress` / `GetSystemTimePreciseAsFileTime` / `api-ms-win-core-synch-l1-2-0` 等 Win8+ 痕迹即硬性拦截）→ 本机冒烟。

**前置工具链**：

| 组件 | 现状 | 动作 |
|---|---|---|
| Visual Studio 2022 (17.6+) | **缺失**（本机仅 VS2019 16.11.31） | 需装 `Microsoft.VisualStudio.2022.BuildTools`，勾选「使用 C++ 的桌面开发」+「Windows 10 SDK」。可与 VS2019 并存，VS2019 保留给备选 CEF 路线 |
| Windows 10 SDK | 已有 4 个版本（10240 / 17763 / 19041 / 22000） | 直接使用 |
| Python | 3.11.5（Anaconda） | 就绪 |
| NASM | 已有（WinLibs mingw64） | 就绪 |
| Node（构建主机） | 24.13.0 | 就绪 |

> Node 22 的官方支持矩阵要求 VS2022。VS2019 的 C++20 支持不完整，编译会在中途失败 —— 这不是可绕过的配置问题，必须装 VS2022 Build Tools。

### 3.2 壳层：Electron 44.0.0 → 22.3.27

**改动点**：
1. `dsh-desktop-next/package.json` 与 `dsh-plugin-desktop/package.json` 的 `devDependencies.electron` 改为 `22.3.27`；`electron-builder` 相应下调（26.x 对 Electron 22 仍可用，但需实测 NSIS 工具链）。
2. 26 处 `WebContentsView` 改写为 Electron 22 可用形态（`contentView` + `BrowserWindow` 组合）。
3. `host-process.ts` 的 host 启动分支改指自编译 `node.exe`，并注入 `NODE_SKIP_PLATFORM_CHECK` 不再需要（补丁已移除该检查）。
4. `electronFuses` 与 `npmRebuild:false` 保持：N-API 模块决定了不需要 rebuild。

**已备好的物料**：`E:\Desktop\DSHV3\verify\e22\electron.exe`（Electron 22.3.27 win32-x64 完整包，97 MB，导入表已验干净）。
构建时放入 electron-builder 缓存目录即可免去联网下载：`%LOCALAPPDATA%\electron\Cache\`。

### 3.3 前端层：降级到 Chromium 108

1. **Tailwind v4 → v3.4**：`@theme` 迁回 `tailwind.config.js`，插件链重排。
2. **CSS 特性替换**（约 160 处）：
   - `color-mix()` 90 处 → 构建期预计算为具体色值
   - `popover` 属性 40 处 → 自建浮层 + focus trap
   - `anchor()` 21 处 → JS 定位
   - `field-sizing` 4 / `light-dark()` 2 / `@starting-style` 2 / `oklch()` 1 → 等价手写
   - `:has()` 79 处、`@container` 9 处、`@property` 4 处 —— Chromium 108 已支持，保留
3. **构建目标**：Vite 8 默认 target 高于 Chromium 108，需显式固定 `build.target = 'chrome108'`（`dsh-plugin-desktop-beta/vite.client.config.ts` 及其 re-export）。
4. **对照基线**：先在 Win7 上装 Chrome 109 访问现有部署，逐屏记录回归，形成精确工单再动手。

---

## 4. 离线化设计

### 4.1 自动更新：零代码禁用

`apps/desktop/src/update-coordinator.ts:54`：

```ts
private readonly enabled: () => boolean =
  () => app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml'))
```

**不打包 `app-update.yml`，自动更新即自动关闭**（`enabled()` 返回 false，`checkForUpdates` 抛 `'desktop update: this application has no packaged update source'`，由既有分支接住）。这一条至关重要 —— 否则 Win7 定制版一旦联网更新就会变回官方版并直接失效。

同时移除/清空 electron-builder 的 `publish` 配置。

### 4.2 运行期自带全部依赖

原发行版已内嵌完整运行时，本方案沿用同一结构并做替换：

| 目录 | 现体积 | 处置 |
|---|---|---|
| `runtime/primary-runtime/dependencies/node` | 89.4 MB | **替换为自编译 node.exe** |
| `runtime/primary-runtime/dependencies/python` | 164.9 MB | 降 3.9（Office 技能）；若接受裁剪可整体移除省 165 MB |
| `runtime/primary-runtime/dependencies/pnpm` | 17.8 MB | 保留（插件市场安装用；离线时该功能自然不可用） |
| `resources/app.asar.unpacked` | 242.7 MB | 保留（N-API 二进制直接复用） |
| `locales` | 48.3 MB | 保留 |

### 4.3 构建期物料预热（构建主机联网一次即可）

| 物料 | 来源 | 缓存位置 |
|---|---|---|
| Electron 22.3.27 win32-x64 | **已下载** | `%LOCALAPPDATA%\electron\Cache\` |
| Node 22.20.0 源码 | 脚本自动 | `build\node-win7\` |
| NSIS 工具链 | electron-builder 自动 | `%LOCALAPPDATA%\electron-builder\Cache\nsis\` |
| winCodeSign | electron-builder 自动 | 同上 |
| dshmarket（`market:prepare`） | npm latest | 需在打包前完成并锁定 lockfile |
| agents-anywhere bridge（`aa:prepare-release`） | 构建产物 | 同上 |

---

## 5. 实施阶段与工作量

| 阶段 | 内容 | 产出 | 人日 |
|---|---|---|---|
| 0 | 前置：Win7 位数确认 + SP1 补丁（KB2533623 / KB4474419 / KB2999226 / KB3125574）+ 装 VS2022 Build Tools | 环境就绪 | 2 |
| 1 | **编译 Node 22 Win7 补丁版**，Win7 真机验证 | `node.exe` 通过导入表校验 + 真机跑通 JS | 5～8 |
| 2 | 壳降级：Electron 22.3.27 + 26 处 `WebContentsView` 改写 + host 启动指向新 node | Win7 上起窗并连上 19387 | 5～8 |
| 3 | 前端降级：Tailwind v3.4 + 约 160 处 CSS + target chrome108 | 前端在 Chromium 108 无阻断渲染 | 10～15 |
| 4 | 运行时组装：Python 3.9、ripgrep 13.x、终端降级分支、禁用自动更新 | 完整 runtime 目录 | 5～8 |
| 5 | 离线打包 + NSIS 产出 + 断网真机验收 | `Setup.exe` | 5～8 |
| | | **合计** | **32～49** |

阶段 1 是关键路径，其余阶段可并行。

---

## 6. 目标机验收清单

在**断网**的 Win7 SP1 x64 上执行：

```cmd
:: 6.1 运行时自证
<install>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe -e ^
  "console.log(process.version, process.versions.modules); ^
   console.log(typeof Promise.withResolvers, typeof require('node:sqlite').DatabaseSync); ^
   console.log(new Intl.DateTimeFormat('zh-CN').format(new Date()))"
```

判据：打印 `v22.20.0` 与两个 `function`/`object`，且中文日期格式正常（验证 ICU）。

```
:: 6.2 应用级
1. 双击 Setup.exe 完成安装（全程无网络请求）
2. 冷启动：主窗口出现，无启动错误弹窗
3. 登录 / 会话建立
4. 多轮对话（含工具调用）
5. 文件读写与命令执行（powershell.exe 5.1 路径）
6. 崩溃恢复窗口可用
7. 确认「关于」中版本号为定制版，且无自动更新提示
8. 卸载干净（注册表、快捷方式、用户数据目录）
```

---

## 7. 风险与回退

| 风险 | 等级 | 说明与对策 |
|---|---|---|
| VS2019 编译 Node 22 失败 | 高 | 已确认必须用 VS2022 Build Tools。这是官方要求，非配置问题 |
| 编译通过但 Win7 运行时崩 | 中 | 导入表只能证明静态依赖干净，V8/libuv 仍可能在运行期 `GetProcAddress` 探测 Win8+ 接口。对策：阶段 1 必须在 Win7 真机跑长稳脚本（定时器、fs、网络、worker_threads、Intl）后再进入阶段 2 |
| `GetSystemTimeAsFileTime` 精度下降 | 低 | `UV_CLOCK_REALTIME` 精度由 <1 μs 降至约 15.6 ms。若后续发现对性能测量有影响，可改用 `QueryPerformanceCounter` + 系统时间基准实现高精度回退 |
| Electron 22 已 EOL | 高 | Chromium 108 的已知漏洞不再修复。这是移植 Win7 的固有代价，与实施质量无关。备选：CEF 109 + Qt 5.15.2 自建宿主（此时 VS2019 + Qt5 成为主线，代价 +30 人日） |
| 前端视觉回归 | 中 | Tailwind 大版本回退 + 160 处 CSS 替换必然改变渲染细节。对策：先用 Chrome 109 建立对照基线再动手 |
| 子系统功能缺失 | 中 | 终端伪终端、语音、浏览器自动化在 Win7 上属不可恢复项，需在 UI 上明确降级呈现 |
| 上游跟进成本 | 中 | Node 补丁以独立 patch 文件承载，DSH 侧改造做成独立补丁包，避免直接改上游源码，便于 0.2.1+ 回归 |

---

## 8. 已产出物料

| 文件 | 说明 |
|---|---|
| [`patches/node-win7-sp1.patch`](patches/node-win7-sp1.patch) | Node 22.20.0 的 2 处 Win7 补丁（git apply / patch -p1 通用格式） |
| [`scripts/build-node-win7.ps1`](scripts/build-node-win7.ps1) | Node 补丁版构建脚本：前置检查 → 补丁 → 全树残留复核 → 编译 → 导入表校验 → 冒烟 |
| [`dsh-win7-feasibility.md`](dsh-win7-feasibility.md) | 可行性分析（含各候选运行时的完整实测矩阵） |
| `verify/e22/` | Electron 22.3.27 win32-x64 完整包（导入表已验） |
| `verify/n18/` `verify/n22/` 等 | 各候选 Node 官方二进制（用于对照验证） |

### 立即执行

```powershell
# 1. 先只校验补丁正确性（无需 VS2022，约 2 分钟）
powershell -ExecutionPolicy Bypass -File E:\Desktop\DSHV3\scripts\build-node-win7.ps1 -SkipBuild

# 2. 装好 VS2022 Build Tools 后正式编译
winget install Microsoft.VisualStudio.2022.BuildTools
powershell -ExecutionPolicy Bypass -File E:\Desktop\DSHV3\scripts\build-node-win7.ps1 -FullIcu
```

> 本机 PowerShell 为 Windows PowerShell 5.1（无 `pwsh`），脚本已按 5.1 语法编写并保存为 **UTF-8 with BOM**（5.1 对无 BOM 的 UTF-8 会按 ANSI 解码，中文注释会破坏解析）。

编译完成后，把 `build\node-win7\out\node.exe` 拷到 Win7 真机执行第 6.1 节自证命令 —— 这一步通过，方案 A 的关键路径即被打通。
