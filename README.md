# Deepseek Harness (DSH) Desktop for Windows 7 SP1

> English version below — [jump to English](#english)

把 DSH Desktop 适配到 **Windows 7 SP1 64 位**。上游产品基于 Electron 44，在 Win7 上**完全无法启动**；
本仓库包含适配层、定位每个问题的验证工具，以及让结果能**离线安装**的打包改动。

---

## 一、它能做什么

### Office 自动化（核心能力，已实测通过）

内置 **Python 3.8.10** 与 **LibreOffice**，装完即用，**无需任何额外安装、无需联网**。

| 能力 | 说明 |
|---|---|
| **Word** | 创建、读取、编辑、检查 `.docx`——报告、信函、格式化表格 |
| **Excel** | 数据、公式、格式处理，含 pandas 分析；支持公式重算 |
| **PowerPoint** | 幻灯片、文本、表格、图片、图表 |
| **转 PDF** | `doc/docx/odt` → pdf；`xls/xlsx/ods` → pdf/csv；`ppt/pptx/odp` → pdf |
| **渲染为图片** | 上述全部格式 + PDF → PNG（支持指定页码、DPI、工作表区域）|
| **结构校验** | 段落、表格、节、页边距等，输出 JSON 报告 |

### 内置技能（8 个）

**Office 三件套**：`office-docx`、`office-pptx`、`office-xlsx`

**框架开发**：`cordis-plugin-development`、`editing-cordis-compositions`、
`cordis-composition-reference`、`agent-experience`

**系统诊断**：`diagnose-windows-sandbox-acl`（Windows 沙箱权限拒绝的排查与修复）

> 对比：Win11 参考版只有 3 个 office 技能，本版多 5 个。

### 内置工具（21 个）

| 类别 | 工具 |
|---|---|
| 文件 | `fs`、`fs-search`、`str-replace-editor` |
| 执行 | `bash`、`pwsh`（各含 persistent 版）|
| 网络 | `web` |
| 协作 | `subagent`、`subagent-control`、`jobs`、`workflow` |
| 规划 | `todo`、`goal`、`present` |
| 其它 | `skill`、`cordis`、`ralph`、`ask-user`、`call-timeout-policy`、`workspace-dependencies` |

### 离线

安装**不需要网络**，运行**不需要网络**。四份 Windows 7 系统补丁随安装包提供，安装时自动探测。

---

## 二、怎么使用

### 安装

1. **确认系统**：64 位 Windows 7 SP1（32 位会被安装程序拒绝）。
2. **装系统补丁**——**顺序重要**，否则 `KB4474419` 会报"不适用于此计算机"：

   ```
   KB4490628  →  KB4474419  →  KB2999226  →  KB4019990
   (服务栈更新)   (SHA-2 签名)   (UCRT 运行时)  (D3DCompiler)
   ```

   四份 MSU 都在安装包的 `resources\win7-prerequisites\` 里，安装时会提示是否缺失。
   也可以直接装 `KB3125574` 便利汇总（已含前三者）。

3. **运行安装程序**，按向导完成。桌面会出现快捷方式（**无控制台窗口**）。

### 启动

双击桌面快捷方式即可。快捷方式指向一个 `.vbs` 启动器：它隐藏控制台窗口，
并在进程异常退出时**自动重试**（最多 3 次）——这是为早期"启动即消失"的问题保留的兜底。

### 使用 Office 能力

直接用自然语言提要求即可，例如：

- 「把这份数据整理成 Excel，带汇总行和公式」
- 「根据大纲生成一份 Word 报告」
- 「把这个 pptx 转成 PDF 并渲染成图片给我看」

助手会自动调用内置的 Python 与 LibreOffice 完成，**不需要你装任何东西**。

### 安装插件

**在应用内安装**：设置 → 插件 → 安装，填包名或本地目录路径。

⚠️ **从本地目录安装时，请让该目录长期保持在原位置**——本版会把它复制进 Profile，
但安装那一刻仍会读取该目录。

### 卸载

控制面板 → 程序和功能 → DSH Desktop Beta。

---

## 三、解决的思路

上游基于 Electron 44，在 Win7 上根本起不来。适配过程中暴露了**四个独立问题**，
每个都必须先解决上一个才会显现。

### 问题 1：启动约 1.5 秒后进程被 V8 中止

**现象**：Electron 22（最后一个支持 Win7 的版本）在 Win7 和 Win11 上都是——启动、
画出界面、约 1.5 秒后以 `0x80000003` 死亡。受影响机器上的 **57 份崩溃转储全部落在同一偏移**，
符号化后是 `v8::base::EmulatedVirtualAddressSubspace::FreePages`。

**排查思路**——按排除法逐层缩小：

| 假设 | 验证方式 | 结果 |
|---|---|---|
| V8 的 GC/JIT 触发 | 试 **8 组 V8 开关**（含 `--jitless`、`--single-threaded`）| 全部仍崩 |
| cage 预留窗口被污染 | **延迟加载模块**，让 ESM 图避开那个窗口 | 无变化 |
| 某个应用动作触发 | **100ms 心跳** + 逐步标记 | 最后心跳在 1.5 秒，此时主进程**完全空闲**——无 Host RPC、无渲染器 IPC、无进程退出事件 |

三条都排除后，结论只能是 **V8 构建本身**。换 **Electron 21（V8 10.6）后不再中止**，
同一套应用代码可无限运行。

**修复**：降级到 Electron 21。

### 问题 2：Node 16.16 缺少 12 个具名导出

**思路**：ESM 缺少具名导出会**中止整个模块图的实例化**，表现为"窗口永远不出现"而非报错，
极易误判。用目标 Electron **实际运行**探测（在构建机上探测只会用宿主的新 Node，什么都查不出来），
一次性列出全部缺失项，在打包期逐个替换。

其中 `util.parseArgs` 用了**忠实实现**而非"够用就行"的版本——适配运行时不能改变调用方能观察到的行为。

### 问题 3：前端需要 4 个 Chromium 106 没有的 API

**思路**：Electron 21 是 Chromium 106，而打包的前端调用了四个更晚才有的 API：

| API | 引入版本 | 缺失时的症状 |
|---|---|---|
| `Array.prototype.toSorted` | 110 | 模型提供商列表排序时抛错 |
| `AbortSignal.any` | 116 | 请求无法组合 |
| `Promise.withResolvers` | 119 | 连接建立失败 |
| `Set.prototype.union` | 122 | 数据处理抛错 |

每一次抛出都会**tear down 网关 websocket**，所以界面开着却什么都没有——没有模型、发不出消息。

**修复**：条件是 `typeof` 守卫的 polyfill，注入打包产物。在更新的运行时上是**死代码**，不改变任何行为。

### 问题 4：sandboxed preload 无法加载

**思路**：两个 shell 视图都用 `sandbox: true`。而 sandboxed preload **只能 `require('electron')`**，
我们的 preload 却需要通过 `electron-api.ts` 的 CommonJS 桥（因为 Electron 22 没有
`electron` 的 ESM 具名导出互操作），那需要 `node:module` 和 `node:url`。
结果 preload **整个加载失败**，`window.desktopChrome` 为 undefined——标题栏拖不动、chrome 状态拿不到。

**修复**：关闭 sandbox。`contextIsolation` 与 `nodeIntegration` 保持不变，渲染器仍与 Node 隔离。

### 附带修复：本地插件安装后崩溃

**现象**：本地目录装插件，当时可用；**关掉应用再开**就进恢复模式，报
`cannot resolve package "<名字>" from the Desktop installation or active Profile`。

**定位思路**：先看清 Profile 里的实际状态——

```
node_modules\           <SYMLINKD> dsh-computer-use  → 桌面目录
node_modules\@dickpy\   <JUNCTION> dsh-imagegen     → 桌面目录
.pnpm\                  只有 lock.yaml（没有任何包）
```

全是**符号链接**，一个包都没真正落进 Profile。再读 `package-overlay.ts`：

```ts
const offset = relative(modules, manifestPath)
if (offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) return undefined
```

Profile **只认落在自己 `node_modules` 内**的包。而 Node 解析模块默认跟随符号链接，
于是 `realpath` 落到桌面 → 算出 `..\..\..` 开头 → 判定越界 → 报"无法解析"。

**根因**：`pnpm add <绝对目录>` 会记成 `link:<目录>`——**投影**，不是安装。
（上游代码里没有任何 `link:` 字面，是 pnpm 自己这么记的。）

**修复**：在两处让绝对目录改走 `file:`，pnpm 就会**复制进 Profile**：

1. `@deepseek-ai/dsh-plugin-manager`——**真正的路径**（Host 进程侧），在**打包期打补丁**；
2. `pnpm.ts`——Desktop 侧那条路，覆盖 `add`/`install`/`i` 三种命令。

> 值得记下的教训：我一开始只改了 Desktop 侧，**够不到 Host 侧的那条路**，
> 所以用户"重开仍崩溃"。是**实际去看 Profile 里的文件形态**（`dir /aL`）才定位到真路径的。

### 附带修复：两个"只有真跑起来才会暴露"的问题

**1. `check_office.py` 用了 Python 3.9+ 的 `str.removeprefix`**
打包的是 Python 3.8.10（Win7 能用的最后版本），所以每次结构校验都崩 `AttributeError`。
已改为 3.8 兼容写法。

**2. 兼容补丁破坏了 shebang**
补丁把 polyfill **prepend 到第 1 行**，而 `#!` **只在首行才是注释**——
LibreOffice Kit CLI 开头是 `#!/usr/bin/env node`，被挤下去后整个文件变语法错误，**CLI 完全无法启动**。
已改为插在 shebang 之后。

### 方法上的收获

三个工具解决了大部分问题，保留在 `work/`：

| 工具 | 用途 |
|---|---|
| `check-node-exports.cjs` | **用目标 Electron 运行**，列出该运行时缺失的具名导出。在构建机上探测只会用宿主的新 Node，证明不了任何事 |
| `read-minidump.mjs` + `sym-lookup.mjs` | 无调试器定位崩溃：异常码 → PE 节 → Breakpad 符号 → 函数名 |
| `patch-node-exports.mjs` | 直接给已装配的应用打补丁，用于**秒级迭代**（免去每轮 15 分钟打包）|

最关键的一条：**必须端到端真跑一遍**。前两个"只有真跑才暴露"的问题——Python 3.8 不兼容、
shebang 被破坏——都是静态检查发现不了的。

---

## 四、已知限制

- **本地插件安装后，Profile 里是真实目录**；源目录之后被移动不影响使用。
- **`@dickpy/dsh-imagegen` 1.6.8 是未构建的源码包**（没有 `lib/`，而 `main` 指向 `lib/index.js`），
  构建前无法启用。
- 渲染器缓存标记为 `immutable`，改了 bundle 需要清缓存才生效。
- 支持 **64 位** Windows 7 SP1；32 位会被安装程序拒绝。

---

## 五、许可

MIT，见 [LICENSE](LICENSE)。上游 DeepSeek Harness 同为 MIT，其声明保留在
`src/dsh-desktop-master/dsh-desktop-next/LICENSE.upstream`。
Electron、Chromium、LibreOffice 的声明随安装包提供。

<br>

---

# English

> 中文版见上 — [回到中文](#dsh-desktop-for-windows-7-sp1)

Running DSH Desktop on **64-bit Windows 7 SP1**. The upstream product targets Electron 44 and does
not start on Windows 7 at all. This repository carries the adaptation layer, the tooling that found
each failure, and the packaging changes that make the result installable offline.

## What it does

### Office automation (core capability, verified end to end)

Ships **Python 3.8.10** and **LibreOffice**. Works immediately after install — **nothing else to
install, no network required**.

| Capability | Detail |
|---|---|
| **Word** | Create, read, edit, check `.docx` — reports, letters, formatted tables |
| **Excel** | Data, formulas, formatting, pandas analysis; formula recalculation |
| **PowerPoint** | Slides, text, tables, images, charts |
| **Convert to PDF** | `doc/docx/odt` → pdf; `xls/xlsx/ods` → pdf/csv; `ppt/pptx/odp` → pdf |
| **Render to images** | All of the above plus PDF → PNG (page ranges, DPI, worksheet areas) |
| **Structural checks** | Paragraphs, tables, sections, margins — reported as JSON |

### Bundled skills (8)

**Office trio**: `office-docx`, `office-pptx`, `office-xlsx`

**Framework development**: `cordis-plugin-development`, `editing-cordis-compositions`,
`cordis-composition-reference`, `agent-experience`

**System diagnostics**: `diagnose-windows-sandbox-acl`

> For comparison, the Windows 11 reference build carries only the three office skills.

### Bundled tools (21)

Files (`fs`, `fs-search`, `str-replace-editor`); execution (`bash`, `pwsh`, each with a persistent
variant); network (`web`); collaboration (`subagent`, `subagent-control`, `jobs`, `workflow`);
planning (`todo`, `goal`, `present`); and `skill`, `cordis`, `ralph`, `ask-user`,
`call-timeout-policy`, `workspace-dependencies`.

### Offline

No network at install, none at run time. The four Windows 7 updates ship with the installer and are
probed during setup.

## Usage

### Install

1. **64-bit Windows 7 SP1** required (32-bit is refused by the installer).
2. **Install the system updates — order matters**, or `KB4474419` reports "not applicable to this
   computer":

   ```
   KB4490628  →  KB4474419  →  KB2999226  →  KB4019990
   (servicing    (SHA-2 code   (UCRT         (D3DCompiler)
    stack)        signing)      runtime)
   ```

   All four MSUs are in the installer's `resources\win7-prerequisites\`, and setup reports any that
   are missing. `KB3125574` (convenience rollup) supersedes the first three.

3. **Run the installer** and follow the wizard. A desktop shortcut appears — **with no console
   window**.

### Launch

Double-click the desktop shortcut. It points at a `.vbs` launcher that hides the console and
**retries automatically** (up to three times) if the process dies abnormally — a safety net kept
from the early "starts and vanishes" problem.

### Office work

Ask in plain language — "turn this data into an Excel sheet with totals and formulas", "draft a Word
report from this outline", "convert this pptx to PDF and render the pages as images". The assistant
uses the bundled Python and LibreOffice; **you install nothing**.

### Installing plugins

Settings → Plugins → Install, then a package name or a local directory path.

⚠️ Keep a locally installed plugin's source directory where it is: this build copies the package into
the Profile, but the install step still reads that directory.

## How it was fixed

Four independent problems, each of which had to be fixed before the next became visible.

### 1. V8 aborts the process about 1.5 s after startup

Electron 22 — the last release that starts on Windows 7 SP1 — painted the interface and then died
with `0x80000003` on both Windows 7 and Windows 11. **All 57 crash dumps on the affected machine
landed on one offset**, which symbolized to
`v8::base::EmulatedVirtualAddressSubspace::FreePages`.

Eliminated in turn:

| Hypothesis | Check | Result |
|---|---|---|
| GC/JIT in V8 | **8 V8 flag combinations**, including `--jitless` and `--single-threaded` | all still aborted |
| The cage-reservation window | **Deferred module loading** so the ESM graph avoids it | no change |
| Some application action | **100 ms heartbeat** plus per-step markers | last tick at 1.5 s with the process **entirely idle** — no Host RPC, no renderer IPC, no process-gone event |

With all three excluded, the V8 build itself was the only remaining candidate.
**Electron 21 (V8 10.6) does not abort**; the same application code runs indefinitely on it.

### 2. Node 16.16 lacks twelve named exports

A missing named export **aborts ESM instantiation of the whole graph**, which presents as a window
that never appears rather than as an error. Measuring it means **running the target Electron** — a
probe on the build host uses the host's much newer Node and finds every name present. All twelve are
replaced at packaging time, with a **faithful** `util.parseArgs` rather than an approximate one:
adapting a runtime must not change what a caller observes.

### 3. The frontend needs four APIs Chromium 106 lacks

Electron 21 is Chromium 106. `Array.prototype.toSorted` (110), `AbortSignal.any` (116),
`Promise.withResolvers` (119) and `Set.prototype.union` (122) all arrived later. Each throw **tore
down the gateway websocket**, so the interface opened and stayed empty. Conditional `typeof`-guarded
polyfills are injected into the packaged bundles — dead code on any newer runtime.

### 4. Sandboxed preloads cannot load

Both shell views used `sandbox: true`, but a sandboxed preload may only `require('electron')`.
Ours routes that import through the CommonJS bridge in `electron-api.ts` — required because Electron
22 has no ESM named-export interop for `electron` — and needs `node:module` and `node:url`. The
preload failed to load entirely, leaving `window.desktopChrome` undefined: no titlebar drag, no
chrome state. `contextIsolation` and `nodeIntegration` still isolate the renderer.

### Also fixed: plugins broke on the next launch

Installed from a local directory, a plugin worked, then the app stopped in recovery on restart with
`cannot resolve package "<name>"`. Inspecting the Profile showed why:

```
node_modules\           <SYMLINKD> dsh-computer-use  → the desktop folder
node_modules\@dickpy\   <JUNCTION> dsh-imagegen     → the desktop folder
.pnpm\                  only lock.yaml — no packages at all
```

Everything was a **symlink**; nothing had been installed into the Profile. `package-overlay.ts`
requires packages to resolve *within* the Profile's own `node_modules`, and Node follows symlinks by
default, so the resolved path fell outside and was rejected. The cause is that
`pnpm add <absolute-dir>` records `link:<dir>` — a projection, not an install. Both the
plugin-manager (Host side, patched at packaging time) and `pnpm.ts` (Desktop side, covering
`add`/`install`/`i`) now rewrite absolute directories to `file:`, which makes pnpm copy the package
in.

> Worth recording: the first attempt only patched the Desktop side and **never reached the Host's
> path**, so restarts still failed. It took looking at the actual files in the Profile (`dir /aL`) to
> find the real one.

### Two problems only a real run exposes

**`check_office.py` used `str.removeprefix`** (Python 3.9+), while the packaged runtime is Python
3.8.10 — the last CPython supporting Windows 7 — so every structural check raised `AttributeError`.

**The compatibility preamble broke a shebang.** It was prepended to line one, but `#!` is only a
comment when it is the very first line. The LibreOffice Kit CLI starts with `#!/usr/bin/env node`;
pushed off line one it became a syntax error and the CLI would not start. The preamble now goes after
the shebang.

### Tooling worth keeping

`check-node-exports.cjs` (run with the target Electron, not the host's Node); `read-minidump.mjs`
with `sym-lookup.mjs` (crash localization without a debugger); `patch-node-exports.mjs` (patch an
assembled app in place, for second-scale iteration instead of a 15-minute packaging round).

The single most valuable habit: **run it end to end**. Both problems that only a real run exposed
were invisible to static checks.

## Known limitations

- Local plugin installs now land as real directories in the Profile.
- **`@dickpy/dsh-imagegen` 1.6.8 is an unbuilt source package** (no `lib/`, while `main` points at
  `lib/index.js`); it cannot be enabled until built.
- The renderer cache is served `immutable`, so a changed bundle needs a cache clear.
- 64-bit Windows 7 SP1 only.

## License

MIT — see [LICENSE](LICENSE). The upstream DeepSeek Harness is MIT as well; its notice is carried in
`src/dsh-desktop-master/dsh-desktop-next/LICENSE.upstream`. Electron, Chromium and LibreOffice
notices ship with the installer.
