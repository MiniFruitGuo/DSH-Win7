# DSH Desktop for Windows 7 SP1

Windows 7 SP1 (64-bit) build of DSH Desktop, adapted from the upstream Electron 44 product so that
it runs, and keeps running, on the last OS that still ships Electron support.

The upstream product targets Electron 44. That release does not start on Windows 7 at all: Chromium
in it requires a newer OS. This tree carries the adaptation layer, the verification tooling that
found each failure, and the packaging changes that make the result installable offline.

## What was actually wrong

Four independent problems, each of which had to be fixed before the next one became visible.

### 1. V8 aborts the process one second after startup

Electron 22 (V8 10.8) is the last release that starts on Windows 7 SP1. On both Windows 7 and
Windows 11 it started, painted the interface, and then died about 1.5 s later with `0x80000003`. All
57 crash dumps on the affected machine landed on the same offset, which symbolized to
`v8::base::EmulatedVirtualAddressSubspace::FreePages`.

Diagnosis ruled out the obvious candidates in order:

- **8 V8 flag combinations** (including `--jitless` and `--single-threaded`) — all aborted.
- **Deferring module loading** so the ESM graph no longer loads during the window where V8 reserves
  its pointer-compression cage — no change. This proved the abort was *not* in the reservation
  window.
- **A startup heartbeat** that ticked every 100 ms: the last tick landed at 1.5 s, after
  `startup-path-finished`, with the main process completely idle — no Host RPC, no renderer IPC, no
  `render-process-gone`. The trigger was not application activity at all.

That left the V8 build itself. **Electron 21 (V8 10.6) does not abort**, and the same application
code runs indefinitely on it.

### 2. Node 16.16 lacks twelve named exports

Electron 21 embeds Node 16.16 rather than 16.17. Missing named exports abort ESM instantiation of
the whole graph, which surfaces as a window that never appears rather than as an error. Twelve are
replaced at packaging time by `scripts/node16-export-polyfills.ts` — including a faithful
`util.parseArgs`, not a "good enough" one, because this shell adapts a runtime and must not change
what a caller observes.

### 3. The frontend needs four APIs Chromium 106 does not have

Electron 21 is Chromium 106. Four APIs the bundled frontend calls arrived later:

| API | Chromium | Symptom when missing |
|---|---|---|
| `Array.prototype.toSorted` | 110 | model-provider list throws while sorting |
| `AbortSignal.any` | 116 | requests cannot be composed |
| `Promise.withResolvers` | 119 | connection setup fails |
| `Set.prototype.union` | 122 | data handling throws |

Each throw tore down the gateway websocket, so the interface opened and stayed empty — no models,
nothing sendable. Conditional polyfills are injected into the packaged bundles, guarded by `typeof`
so they are dead code on any newer runtime.

### 4. Sandboxed preloads cannot load

Both shell views used `sandbox: true`. A sandboxed preload may only `require('electron')`, but ours
routes that import through the CommonJS bridge in `electron-api.ts` — required because Electron 22
has no ESM named-export interop for `electron` — and the bridge needs `node:module` and `node:url`.
The preload failed to load entirely, leaving `window.desktopChrome` undefined: no titlebar drag, no
chrome state, and a `reading 'subscribe' of undefined` error in the frame.

`contextIsolation` and `nodeIntegration` still isolate the renderer from Node.

## Titlebar drag

`-webkit-app-region: drag` is honoured by `WebContentsView` and by a window's own webContents — but
not by `BrowserView`, which is the only child-view API the Electron releases in use here have. Worse
than inert, the declaration suppresses the mouse events a JS implementation needs. Where the frame is
a `BrowserView`, the renderer neutralises the declaration and forwards the gesture; the main process
moves the window by following the cursor.

## Windows 7 prerequisites

Electron requires four updates; the installer ships all of them and probes for them before
installing. **Install order matters** — the servicing stack update must come first or `KB4474419`
reports "not applicable to this computer":

```
KB4490628  →  KB4474419  →  KB2999226  →  KB4019990
(SSU)         (SHA-2)       (UCRT)        (D3DCompiler)
```

`KB3125574` (convenience rollup, 476 MB) supersedes three of them and is published as a Release
asset rather than committed.

64-bit Windows 7 SP1 is required; the installer refuses 32-bit systems.

## Layout

```
src/dsh-desktop-master/dsh-plugin-desktop-beta/   the edition developed and packaged here
src/dsh-desktop-master/dsh-plugin-desktop/        the other edition, kept byte-aligned by the gate
src/dsh-desktop-master/scripts/                   build, packaging and verification tooling
work/                                              diagnostic scripts (not committed; see below)
build/                                             packaging payloads: prerequisite MSIs, launchers
```

`dsh-plugin-desktop-beta/` is developed first; shared changes are copied to `dsh-plugin-desktop/`
preserving the declared variant differences, and `scripts/verify-desktop-variants.mjs` gates that
207 shared sources and the build payloads stay aligned.

## Building

Requires Node 22.19+ or 24+ and the pinned Yarn through Corepack.

```sh
cd src/dsh-desktop-master
corepack yarn install --immutable
cd dsh-plugin-desktop-beta
corepack yarn build
DSH_PACKAGE_CHECK_ALREADY_RAN=1 node scripts/package-win.ts
```

Packaging takes about 15 minutes and ends with `Windows installer verification passed`.

## Verification tooling

The tools that found these problems are kept because the next adaptation will need them.

| Tool | Purpose |
|---|---|
| `check-node-exports.cjs` | Run **with the target Electron** to list the named exports that runtime lacks. A probe on the build host uses the host's much newer Node and finds every name present — it proves nothing. |
| `patch-node-exports.mjs` | Patch an assembled application in place, for second-scale iteration instead of a 15-minute packaging round. |
| `electron-api-audit` | Validate every named `'electron'` import in the sources against a specific Electron release, plus instance-member usage. |
| `read-minidump.mjs`, `sym-lookup.mjs`, `pe-section-of.mjs` | Crash localization without a debugger: exception code → PE section → Breakpad symbol → function name. |
| `probe-v8-flags.ps1` | Try many V8 flag combinations on a machine that reproduces the failure. |
| `vm-test.ps1` | Drive a whole test round through `vmrun`: copy in, install silently, launch, capture the screen, pull logs. |

## Known limitations

- **Local plugins must be installed as `file:`, not `link:`.** pnpm records a bare directory target
  as `link:<dir>`, which creates a junction pointing outside the Profile. The Profile contract
  requires packages to resolve *within* its own `node_modules`, so the next launch fails with
  `cannot resolve package`. `runPlugin` rewrites bare local directory targets to `file:` before the
  argument reaches the upstream CLI.
- **`@dickpy/dsh-imagegen` 1.6.8 is an unbuilt source package** — no `lib/`, while `main` points at
  `lib/index.js`. It cannot be enabled until it is built.
- The renderer cache is served with `immutable`, so a changed bundle needs a cache clear to take
  effect.

## License

MIT — see [LICENSE](LICENSE). The upstream DeepSeek Harness is MIT as well; its notice is carried in
`src/dsh-desktop-master/dsh-desktop-next/LICENSE.upstream`. Electron, Chromium and LibreOffice
notices ship with the installer.
