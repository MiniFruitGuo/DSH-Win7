DSH Desktop — Windows 7 SP1 x64 测试包
=====================================

本目录三个文件：

  DSH-Desktop-Beta-2.0.17-beta.1-x64-Setup.exe   安装包（262 MB，离线自足）
  collect-desktop-startup-evidence.ps1           启动取证脚本（无法启动时用这个）
  verify-windows7-acceptance.ps1                 产物/环境验收脚本（装完想体检时用）

SHA256（安装包）: 2A79257BC45DAE7AEFAC09216EDD6E312C2200D76C6C470643B722E18D43B726


一、安装前确认
--------------------------------
1. 虚拟机必须是 64 位 Windows 7 SP1。在 VM 里执行：

     wmic os get osarchitecture,version

   期望：64-bit / 6.1.7601。若显示 32-bit，本安装包（x64）会在安装前直接拒绝并说明原因。

2. 系统补丁：**安装包已内置 4 个必需补丁**，安装时若检测到缺失会弹窗告知（弹窗会写明
   它们放在 <安装目录>\resources\win7-prerequisites）。补丁如下：

     Windows6.1-KB2999226-x64.msu     0.99 MB   通用 C 运行库（UCRT）
     KB4019990-x64.msu                2.74 MB   d3dcompiler 更新（Chromium 渲染）
     KB4490628-x64.msu                9.10 MB   服务栈更新（KB4474419 的前置）
     KB4474419-v3-x64.msu            53.27 MB   SHA-2 代码签名支持

   安装方式：逐个双击 .msu（需要管理员权限），装完**重启**再启动 DSH Desktop。
   安装包不会静默安装它们——每个都需要提权与重启，擅自静默装反而更危险。

3. 关于 KB3125574（Windows 7 SP1 汇总，476.88 MB）：
   本目录的 win7-prerequisites-optional\ 单独提供。**只有"从未打过任何 Windows 更新"的
   裸 SP1 机器才需要它**——它覆盖了一些已被微软下架的前置（例如 KB2533623 的组件，
   该补丁的 Win7 版本现在在 Microsoft Update Catalog 里已经只剩 Vista 版，无法正规获取）。
   之所以不放进安装包：放进去会让安装包从 328 MB 涨到 ~805 MB。

4. VC++ 运行库：实测主程序与自带的 node.exe 都不导入 CRT，因此**不需要** VC++ 2015-2022
   运行库；如你的环境另有组件需要，可自行安装。


二、测试流程
------------
1. 双击安装包，按向导装完（全程不需要联网）。
2. **从桌面快捷方式启动**（重要：这个快捷方式现在指向随包附带的"自动恢复"启动器，
   见下面的说明）。
3. 记录你看到的现象：

   A. 出现主窗口（标题为 DSH Desktop Beta）           -> 成功
   B. 出现「进入恢复模式的原因」窗口，里面有红色错误   -> 部分成功，请继续第 4 步
   C. 启动器提示「stopped while starting ... exit code -2147483645」并停下来
      -> 说明重试次数用尽，请继续第 4 步（这时屏幕上会**留有信息**，不再是一闪而过）
   D. 完全没有反应                                   -> 请继续第 4 步

   ※ 不要点恢复窗口里的「进入安全模式」「重置与数据管理」「回滚」——那些会改动
     Profile 与数据状态，会干扰定位。直接关掉窗口即可。

   ---------------- 关于"自动恢复"启动器 ----------------
   本版在安装目录里多了一个 `DSH Desktop (recovery start).cmd`，桌面快捷方式指向它而不是
   直接指向主程序。原因：Win7 上主程序可能以 native 断言（退出码 -2147483645，即
   0x80000003）在启动途中终止，而且**不留任何窗口和日志**。启动器会在这种情况自动重试，
   默认 3 次（每次间隔约 2 秒）：

     正常退出（码 0）        -> 立刻结束，不做任何干预
     崩溃退出（可重试的码）  -> 显示一行提示后自动重开
     重试用尽                -> 停在窗口上，显示最后一次退出码与补丁目录位置

   想改重试次数：启动前设置环境变量 `DSH_DESKTOP_RECOVERY_ATTEMPTS`（例如 5）。
   想直接跑主程序排查：直接双击 `DSH Desktop Beta.exe` 即可（绕过启动器）。

4. 不管哪种情况，都请运行取证脚本（它会自动抓取证据并打包）：

     powershell -NoProfile -ExecutionPolicy Bypass ^
       -File collect-desktop-startup-evidence.ps1

   脚本会自动找到安装目录、带 stdout/stderr 启动一次、记录窗口标题变化，
   然后把日志、lifecycle 事件、崩溃证据一起打包到桌面：
   dsh-desktop-evidence-<时间>.zip

   高级用法：
     -InstallDir "D:\DSH"      指定安装目录
     -HoldSeconds 120          观察更久（默认 90 秒）
     -SkipLaunch               只收集已有证据，不启动程序

5. 把这个 zip 发回给我即可。里面有：
     report.txt            结论摘要（系统信息、启动观察、stderr、阶段记录）
     stderr.txt            程序自己写出的错误（关键）
     logs/                 应用日志（含 Host 阶段标记 stage=…）
     lifecycle-events/     启动阶段流水（哪个阶段没走完一目了然）
     crash-evidence/       崩溃现场
     Crashpad/reports/     崩溃转储（.dmp，定位崩溃模块全靠它）


三、想额外做体检时（可选）
--------------------------
※ 关于 PowerShell 版本：Windows 7 默认自带的是 Windows PowerShell 2.0。
  本目录的 collect-desktop-startup-evidence.ps1 已按 2.0 重写（不再使用
  -Directory、ConvertFrom-Json、Compress-Archive、Get-Content -Tail、ReadToEndAsync
  等 3.0 以后才有的能力），在没升级过 WMF 的 Win7 上可直接运行；
  如果它连压缩包都建不了（.NET 3.5 没有 ZipFile），它会提示你手动把文件夹压成 zip。
  另一个 verify-windows7-acceptance.ps1 要求 PowerShell 5.1（装了 WMF 5.1 才有）。

装完后可以跑验收脚本，它会检查系统位数/补丁、直接用打包的 node.exe 自证运行时、
检查 rg.exe 版本与更新通道是否已断开、并对产物跑静态导入表门禁：

  powershell -NoProfile -ExecutionPolicy Bypass -File verify-windows7-acceptance.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File verify-windows7-acceptance.ps1 -Json .\acceptance.json

退出码：0 = 无 FAIL，1 = 有 FAIL，2 = 参数错误。非 Win7 专属项会自动降级为 SKIP 而不是 FAIL。


四、当前定位进展（本机 + 你的 VM 两条证据链）
--------------------------------------------
**已找到并修复一个 100% 必现的根因（本版包含此修复）**：

你上一版截图里的启动日志把崩点钉死了 —— 整条链其实**全部走通**：

    profile-composition ... prepared          ✓
    host stage=boot-request / proxy-ready     ✓
    host stage=compose-begin                  ✓
    [native] tray:set ×6（两轮）全部 done      ✓
    host stage=compose-done                   ✓
    host stage=mounted                        ✓   ← Host 挂载完成
    Error: renderer health monitoring stopped ← 这是释放路径的副作用，不是根因
      at ElectronShellGeneration.release
      at ElectronShellGeneration.mount        ← mount 内部走了失败分支

顺着 `mount()` 查到 `compatibility-shell.ts`：它用 `window.contentView.addChildView(...)`。
**`BrowserWindow.contentView` 是 Electron 30 才引入的**，而 Win7 只能用 Electron 22 ——
那台机器上 `window.contentView` 是 `undefined`，于是 mount 抛错、转入释放路径、随后 native abort。

用探针在 Electron 22 上实测确认（`work/api-probe`）：

    electron.WebContentsView = function
    window.contentView       = undefined      ← 不存在
    window.addBrowserView    = function       ← 旧 API 在
    addBrowserView(WebContentsView) → threw: conversion failure at index 0   ← 必现失败
    addBrowserView(BrowserView)     → accepted                               ← 可用

**本版修复**：在旧 API 路径上构建 `BrowserView`（而不是把 `WebContentsView` 交给
`addBrowserView`），并复用同一套 `setBounds` 逻辑。这条路径已被探针证明可用。

**仍然存在但已缓解的问题**：主进程还有另一类**随机**的 native 断言（V8 的
`EmulatedVirtualAddressSubspace::FreePages`，异常码 `0x80000003`），它取决于每次启动的地址空间
布局，本机复现率明显但**你那台机器上此前从未在这一层崩过**（你是稳定死在 mount）。
本版通过"默认软件渲染"降低其概率，并由"自动恢复启动器"覆盖：崩溃自动重开（默认 3 次）。

**结论**：你机器上的必现失败（mount）已修复；随机那一类由启动器兜底。两者叠加后，
这一版在你 VM 上应该能真正进入界面。

五、这个版本相对上一版修了什么
------------------------------
上一版"双击毫无反应"的根因：Electron 22 内嵌的是 Node 16.17.1，而 DSH 的包要求 Node ≥20。
主进程的 ESM 依赖图里只要有一个具名导出不存在，整个进程就在加载阶段退出；而主程序是
GUI 子系统程序，没有控制台，于是错误无处可见。

本版修复六处：
  1) 入口垫层补齐 Node 16 缺失的全局 API（structuredClone、URL.parse/canParse、
     Promise.withResolvers、AbortSignal.timeout/any、stream/web、File、crypto 等）
  2) dsh-app-boot 的 util.parseEnv          -> 等价实现
  3) session-persistence-jsonl 的 zstd 绑定 -> 惰性绑定
  4) dsh-http-proxy 的 undici               -> 策略照旧、dispatcher 降级（Host 是 Node 22，自己装）
  5) package-overlay 的 module.findPackageJSON -> 等价实现
  6) Host 进程不再用 Electron 的 utilityProcess（那是 Node 16），改为 spawn 打包的 node.exe
     + stdio JSON 控制通道 —— 这一条才是"Host 跑在 Node 22"的真正落地
另加：Host 启动阶段标记（日志里的 stage=boot-request / proxy-ready / compose-begin /
compose-done / mounted / failed），失败时能直接看出停在哪一步。


五、已知情况（不用反复试）
--------------------------
- 在我的开发机（Win11）上，本版已经能走到：加载完成 -> 起窗口 -> Profile 组合成功 ->
  Host 起进程并加载 Profile 插件；最后一个待确认点是 Host 的 boot 是否在目标机上完整返回。
  这正是需要你这次 VM 结果的地方。
- 代理：如果 VM 上没有代理环境变量，这一版连降级路径都不会走到，属于正常。
