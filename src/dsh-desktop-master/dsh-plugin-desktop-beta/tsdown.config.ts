import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const PACKAGE_NAME = 'dsh-plugin-desktop-beta'

/**
 * Route every `electron` import through the CommonJS bridge at build time.
 *
 * Electron 22 — the last release supporting Windows 7 SP1 — has no ESM
 * named-export interop for `electron`, so `import { app } from 'electron'`
 * aborts before any product code runs. Aliasing here rather than editing the
 * source keeps `vi.mock('electron')` working in the unit tests, which execute
 * the unaliased sources, while the packaged build reads the CommonJS object.
 */
const ELECTRON_BRIDGE = fileURLToPath(new URL('./src/electron-api.ts', import.meta.url))
const inputOptions = { resolve: { alias: { electron: ELECTRON_BRIDGE } } }
// tsdown treats `electron` as an implicit external, so the alias only takes
// effect once the bare specifier is forced back through the resolver.
const noExternal = ['electron']

export default defineConfig([
  {
    name: PACKAGE_NAME,
    entry: {
      index: 'src/index.ts',
      'module-resolution': 'src/module-resolution.ts',
      webserver: 'src/webserver.ts',
      profile: 'src/profile.ts',
      'profile-manager': 'src/profile-manager.ts',
      'profile-service': 'src/profile-service.ts',
      'profile-context': 'src/profile-context.ts',
      'desktop-plugins': 'src/desktop-plugins.ts',
      pnpm: 'src/pnpm.ts',
      profiles: 'src/profiles.ts',
      diagnostics: 'src/diagnostics.ts',
      notifications: 'src/notifications.ts',
      'diagnostic-export-worker': 'src/diagnostic-export-worker.ts',
      'packaged-runtime-smoke': 'src/packaged-runtime-smoke.ts',
      runtime: 'src/runtime.ts',
      'electron-runtime': 'src/electron-runtime.ts',
      'desktop-runtime-environment': 'src/desktop-runtime-environment.ts',
      'desktop-terminal': 'src/desktop-terminal.ts',
      'desktop-cli': 'src/desktop-cli.ts',
      terminal: 'src/terminal.ts',
      'update-checker': 'src/update-checker.ts',
      'update-download': 'src/update-download.ts',
      updates: 'src/updates.ts',
      'windows-pwsh-sandbox': 'src/windows-pwsh-sandbox.ts',
      'windows-acl-runner': 'src/windows-acl-runner.ts',
      main: 'src/main.ts',
      'host-process-entry': 'src/host-process-entry.ts',
    },
    outDir: 'lib',
    inputOptions,
    noExternal,
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
  },
  {
    name: `${PACKAGE_NAME}/bin`,
    entry: { bin: 'src/bin.ts' },
    outDir: 'lib',
    inputOptions,
    noExternal,
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    outputOptions: {
      banner: '#!/usr/bin/env node',
    },
  },
  {
    // Each preload is built on its own, with every dependency inlined, so it is a single
    // self-contained file.
    //
    // A sandboxed preload (`sandbox: true`, which both shell views use) runs inside Electron's
    // sandboxed bundle and cannot `require` a sibling file. Build the two together and their shared
    // `electron-api` import is extracted into an `electron-api-*.cjs` chunk, which makes the preload
    // fail to load with "module not found: ./electron-api-*.cjs" — silently leaving
    // `window.desktopChrome` undefined. That costs the titlebar drag and the chrome state, and shows
    // up as "Cannot read properties of undefined (reading 'subscribe')" in the frame. Inlining
    // removes the sibling file so the preload resolves on its own.
    name: `${PACKAGE_NAME}/compatibility-preload`,
    entry: { 'compatibility-preload': 'src/compatibility-preload.ts' },
    outDir: 'lib',
    inputOptions,
    noExternal,
    format: 'cjs',
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    outputOptions: {
      entryFileNames: '[name].cjs',
      inlineDynamicImports: true,
    },
  },
  {
    name: `${PACKAGE_NAME}/preload`,
    entry: { preload: 'src/preload.ts' },
    outDir: 'lib',
    inputOptions,
    noExternal,
    format: 'cjs',
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    outputOptions: {
      entryFileNames: '[name].cjs',
      inlineDynamicImports: true,
    },
  },
])
