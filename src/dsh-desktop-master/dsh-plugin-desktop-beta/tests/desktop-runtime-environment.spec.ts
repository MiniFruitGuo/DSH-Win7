import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, delimiter as pathDelimiter, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installDesktopDshRuntime,
  installDesktopPnpmRuntime,
  type DesktopPnpmRuntimeOptions,
} from '../src/desktop-runtime-environment.ts'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-desktop-pnpm-runtime-'))
  temporaryDirectories.push(directory)
  return directory
}

function options(
  stateDir: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): DesktopPnpmRuntimeOptions {
  return {
    platform,
    appExecutable: platform === 'win32'
      ? 'C:\\Program Files\\DSH 100% Desktop\\DSH Desktop.exe'
      : "/Applications/DSH O'Brien.app/Contents/MacOS/DSH Desktop",
    pnpmBinPath: platform === 'win32'
      ? 'C:\\Program Files\\DSH Desktop\\resources\\app.asar.unpacked\\node_modules\\pnpm\\bin\\pnpm.mjs'
      : "/Applications/DSH O'Brien.app/Contents/Resources/app.asar.unpacked/node_modules/pnpm/bin/pnpm.mjs",
    nodeVersion: '43.4.0',
    stateDir,
    environment,
  }
}

/**
 * cmd.exe decodes a batch file with the console code page, so every embedded path must be read
 * after the shim pins UTF-8, and the pin must be undone because the console outlives the process.
 * Keeping the temporaries inside `setlocal` stops them from reaching the caller's environment.
 */
function expectCodePagePinnedAheadOfEveryPath(shim: string): void {
  const lines = shim.split('\r\n')
  expect(lines.slice(0, 4)).toEqual([
    '@echo off',
    'setlocal DisableDelayedExpansion',
    `for /f "tokens=2 delims=:" %%c in ('chcp 2^>nul') do set "DSH_RUNTIME_CODEPAGE=%%c"`,
    'chcp 65001>nul 2>nul',
  ])
  expect(lines.findIndex(line => /[A-Za-z]:\\|%~dp0/u.test(line))).toBeGreaterThan(3)
  expect(lines.slice(-4, -1)).toEqual([
    'set "DSH_RUNTIME_EXIT=%errorlevel%"',
    'chcp %DSH_RUNTIME_CODEPAGE% >nul 2>nul',
    'exit /b %DSH_RUNTIME_EXIT%',
  ])
  expect(shim).not.toContain('exit /b %errorlevel%')
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('desktop Host pnpm runtime', () => {
  it.each(['darwin', 'linux'] as const)('creates a pnpm-only public PATH on %s', (platform) => {
    const stateDir = join(temporaryDirectory(), 'runtime state')
    const environment: NodeJS.ProcessEnv = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      KEEP: 'value',
      CARRIED_IDENTITY: 'inherited-value',
      npm_config_runtime: 'inherited-runtime',
    }
    const original = { ...environment }

    const installation = installDesktopPnpmRuntime(options(stateDir, platform, environment))

    expect(readdirSync(installation.pathDir)).toEqual(['pnpm'])
    expect(readdirSync(installation.nodeBinDir)).toEqual(['node'])
    const generationRoot = dirname(installation.pathDir)
    const manifest = JSON.parse(readFileSync(join(generationRoot, '.generation.json'), 'utf8')) as {
      contentHash: string
    }
    expect(readdirSync(generationRoot).sort()).toEqual(['.generation.json', 'bin', 'private'])
    expect(basename(generationRoot)).toMatch(new RegExp(`^${manifest.contentHash}-`))
    if (process.platform !== 'win32') {
      expect(lstatSync(stateDir).mode & 0o777).toBe(0o700)
      expect(lstatSync(installation.pathDir).mode & 0o777).toBe(0o700)
      expect(lstatSync(installation.nodeBinDir).mode & 0o777).toBe(0o700)
      expect(lstatSync(installation.pnpmShimPath).mode & 0o777).toBe(0o700)
      expect(lstatSync(installation.nodeShimPath).mode & 0o777).toBe(0o700)
      expect(lstatSync(installation.clearEnvironmentPath).mode & 0o777).toBe(0o600)
    }

    const pnpm = readFileSync(installation.pnpmShimPath, 'utf8')
    expect(pnpm).toContain('runtime_root_dir=${runtime_public_dir%/*}')
    expect(pnpm).toContain('PATH="$runtime_node_bin_dir:${PATH:-}"')
    expect(pnpm).toContain('NODE="$runtime_node_shim"')
    expect(pnpm).toContain('npm_config_runtime=node')
    expect(pnpm).toContain("npm_config_target='43.4.0'")
    expect(pnpm).toContain("npm_config_disturl='https://nodejs.org/download/release'")
    expect(pnpm.match(/--config\.minimumReleaseAge=0/gu)).toHaveLength(1)
    expect(pnpm).toContain('--config.minimumReleaseAge=0 "$@"')
    // The shim runs the packaged Node directly, so no carried preload is involved.
    expect(pnpm).not.toContain('--require')
    const node = readFileSync(installation.nodeShimPath, 'utf8')
    expect(node).toContain(`exec`)
    expect(node).not.toContain('npm_config_')
    const clearEnvironment = readFileSync(installation.clearEnvironmentPath, 'utf8')
    expect(clearEnvironment).toContain("process.execPath = require('node:path').join(__dirname, 'node-bin', 'node')")

    expect(environment).toEqual({
      ...original,
      PATH: `${installation.pathDir}:/usr/local/bin:/usr/bin:/bin`,
    })
    if (process.platform !== 'win32') {
      expect(spawnSync('/bin/sh', ['-n', installation.pnpmShimPath]).status).toBe(0)
      expect(spawnSync('/bin/sh', ['-n', installation.nodeShimPath]).status).toBe(0)
    }

    installation.dispose()
    installation.dispose()
    expect(environment).toEqual(original)
  })

  it('keeps recovered login-shell PATH beneath the Desktop runtime PATH', () => {
    const stateDir = join(temporaryDirectory(), 'runtime')
    const recoveredPath = '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin'
    const environment: NodeJS.ProcessEnv = {
      PATH: recoveredPath,
      KEEP: 'value',
    }
    const original = { ...environment }

    const installation = installDesktopPnpmRuntime(options(stateDir, 'linux', environment))

    expect(environment.PATH).toBe(`${installation.pathDir}:${recoveredPath}`)
    installation.dispose()
    installation.dispose()
    expect(environment).toEqual(original)
  })

  it('publishes the POSIX shim as process.execPath without rewriting the environment', () => {
    const stateDir = join(temporaryDirectory(), 'runtime')
    const installation = installDesktopPnpmRuntime(options(stateDir, 'linux', { PATH: '/usr/bin' }))
    const result = spawnSync(process.execPath, [
      '--import',
      pathToFileURL(installation.clearEnvironmentPath).href,
      '-e',
      'process.stdout.write(JSON.stringify({ execPath: process.execPath, carried: Object.keys(process.env).filter(name => name.startsWith("CARRIED_")) }))',
    ], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        CARRIED_ONE: '1',
        CARRIED_TWO: 'legacy',
      },
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      // Node resolves the preload's __dirname through symlinks (macOS /var -> /private/var).
      execPath: realpathSync(installation.nodeShimPath),
      // The shim is the packaged Node itself, so descendants inherit the environment unchanged.
      carried: ['CARRIED_ONE', 'CARRIED_TWO'],
    })
    installation.dispose()
  })

  it('scopes Electron ABI settings to the pnpm process tree', () => {
    const root = temporaryDirectory()
    const stateDir = join(root, 'runtime')
    const captureEntry = join(root, 'capture.mjs')
    const captureOutput = join(root, 'capture.json')
    writeFileSync(captureEntry, [
      "import { writeFileSync } from 'node:fs'",
      'writeFileSync(process.argv.at(-1), JSON.stringify({',
      "  ignoresMinimumReleaseAge: process.argv.includes('--config.minimumReleaseAge=0'),",
      "  carried: Object.keys(process.env).filter(name => name.toUpperCase() === 'CARRIED_IDENTITY'),",
      '  runtime: process.env.npm_config_runtime,',
      '  target: process.env.npm_config_target,',
      '  disturl: process.env.npm_config_disturl,',
      '  node: process.env.NODE,',
      '  path: process.env.PATH,',
      '}))',
      '',
    ].join('\n'))
    const platform = process.platform === 'win32' ? 'win32' : 'linux'
    const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH }
    const installation = installDesktopPnpmRuntime({
      ...options(stateDir, platform, environment),
      appExecutable: process.execPath,
      pnpmBinPath: captureEntry,
    })

    const command = process.platform === 'win32'
      ? process.env.ComSpec ?? 'cmd.exe'
      : 'pnpm'
    const args = process.platform === 'win32'
      ? ['/d', '/s', '/c', `""${installation.pnpmShimPath}" "${captureOutput}""`]
      : [captureOutput]
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      env: environment,
      shell: false,
      windowsVerbatimArguments: process.platform === 'win32',
    })

    expect(result.error).toBeUndefined()
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    const capture = JSON.parse(readFileSync(captureOutput, 'utf8')) as Record<string, unknown>
    expect(capture).toMatchObject({
      ignoresMinimumReleaseAge: true,
      // The shim is the packaged Node itself and injects no RunAsNode identity.
      carried: [],
      runtime: 'node',
      target: '43.4.0',
      disturl: 'https://nodejs.org/download/release',
    })
    expect(resolve(String(capture.node))).toBe(resolve(installation.nodeShimPath))
    const [capturedNodeBinDir, ...capturedPath] = String(capture.path).split(pathDelimiter)
    expect(resolve(capturedNodeBinDir ?? '')).toBe(resolve(installation.nodeBinDir))
    expect(capturedPath.join(pathDelimiter)).toBe(environment.PATH ?? '')
    expect(environment).not.toHaveProperty('CARRIED_IDENTITY')
    expect(environment).not.toHaveProperty('npm_config_runtime')
    installation.dispose()
  })

  it.runIf(process.platform === 'win32')(
    'keeps process.execPath descendants in Electron Node mode on Windows',
    () => {
      const root = temporaryDirectory()
      const childEntry = join(root, 'child.mjs')
      const parentEntry = join(root, 'parent.mjs')
      const output = join(root, 'result.json')
      const nodeExecutable = process.execPath
      writeFileSync(childEntry, [
        "process.stdout.write('child-stdout')",
        "process.stderr.write('child-stderr')",
        'process.exitCode = 23',
        '',
      ].join('\n'))
      writeFileSync(parentEntry, [
        "import { spawnSync } from 'node:child_process'",
        "import { writeFileSync } from 'node:fs'",
        'const [childEntry, output] = process.argv.slice(2)',
        "const child = spawnSync(process.execPath, [childEntry], { encoding: 'utf8', windowsHide: true })",
        'writeFileSync(output, JSON.stringify({',
        '  execPath: process.execPath,',
        "  carried: Object.keys(process.env).filter(name => name.toUpperCase() === 'CARRIED_IDENTITY'),",
        '  child: { status: child.status, stdout: child.stdout, stderr: child.stderr },',
        '}))',
        '',
      ].join('\n'))
      const installation = installDesktopPnpmRuntime({
        ...options(join(root, 'runtime'), 'win32', { Path: process.env.Path }),
        appExecutable: nodeExecutable,
        pnpmBinPath: parentEntry,
      })

      const result = spawnSync(nodeExecutable, [
        '--require',
        installation.clearEnvironmentPath,
        parentEntry,
        childEntry,
        output,
      ], {
        encoding: 'utf8',
        env: { ...process.env, CARRIED_IDENTITY: '1' },
        timeout: 30_000,
        windowsHide: true,
      })

      expect(result.error).toBeUndefined()
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      const capture = JSON.parse(readFileSync(output, 'utf8')) as Record<string, unknown>
      expect(resolve(String(capture.execPath))).toBe(resolve(nodeExecutable))
      expect(capture.child).toEqual({
        status: 23,
        stdout: 'child-stdout',
        stderr: 'child-stderr',
      })
      installation.dispose()
    },
  )

  it('creates Windows batch shims without publishing the private Node directory', () => {
    const stateDir = join(temporaryDirectory(), 'runtime-state')
    const environment: NodeJS.ProcessEnv = {
      Path: 'C:\\Windows\\System32;C:\\Windows',
      KEEP: 'value',
    }
    const original = { ...environment }

    const installation = installDesktopPnpmRuntime(options(stateDir, 'win32', environment))

    expect(readdirSync(installation.pathDir)).toEqual(['pnpm.cmd'])
    expect(readdirSync(installation.nodeBinDir)).toEqual(['node.cmd'])
    const pnpm = readFileSync(installation.pnpmShimPath, 'utf8')
    expect(pnpm).toContain('set "DSH_RUNTIME_ROOT=%~dp0.."')
    expect(pnpm).toContain('set "PATH=%DSH_RUNTIME_NODE_BIN%;%PATH%"')
    expect(pnpm).toContain('set "NODE=%DSH_RUNTIME_NODE_BIN%\\node.cmd"')
    expect(pnpm).toContain('set "npm_config_runtime=node"')
    expect(pnpm).toContain('set "npm_config_target=43.4.0"')
    // The shim invokes the packaged Node directly, so no RunAsNode preload is involved.
    expect(pnpm).not.toContain('--require')
    expect(pnpm.match(/--config\.minimumReleaseAge=0/gu)).toHaveLength(1)
    expect(pnpm).toContain('--config.minimumReleaseAge=0 %*')
    const node = readFileSync(installation.nodeShimPath, 'utf8')
    expect(node).not.toContain('--require')
    expect(node).not.toContain('npm_config_')
    for (const shim of [pnpm, node]) expectCodePagePinnedAheadOfEveryPath(shim)
    expect(readFileSync(installation.clearEnvironmentPath, 'utf8')).not.toContain(
      "name.toUpperCase() === 'CARRIED_IDENTITY'",
    )

    expect(environment).toEqual({
      Path: `${installation.pathDir};C:\\Windows\\System32;C:\\Windows`,
      KEEP: 'value',
    })
    expect(environment).not.toHaveProperty('CARRIED_IDENTITY')
    expect(environment).not.toHaveProperty('npm_config_runtime')

    installation.dispose()
    installation.dispose()
    expect(environment).toEqual(original)
  })

  it('removes only its own PATH component when another owner changes PATH later', () => {
    const stateDir = join(temporaryDirectory(), 'runtime')
    const platform = process.platform === 'win32' ? 'win32' : 'linux'
    const originalPath = process.platform === 'win32' ? 'C:\\Windows' : '/usr/bin'
    const laterPath = process.platform === 'win32' ? 'C:\\later' : '/later/bin'
    const environment: NodeJS.ProcessEnv = { PATH: originalPath }
    const installation = installDesktopPnpmRuntime(options(stateDir, platform, environment))
    environment.PATH = `${laterPath}${pathDelimiter}${environment.PATH ?? ''}`

    installation.dispose()
    installation.dispose()

    expect(environment).toEqual({ PATH: `${laterPath}${pathDelimiter}${originalPath}` })
  })

  it('normalizes Windows separators and trailing separators when replacing legacy PATH entries', () => {
    const root = temporaryDirectory()
    const stateDir = join(root, 'runtime-commands')
    const environment: NodeJS.ProcessEnv = { Path: 'C:\\Windows' }
    const first = installDesktopPnpmRuntime(options(stateDir, 'win32', environment))
    first.dispose()
    const legacyPathDir = join(stateDir, 'bin')
    mkdirSync(legacyPathDir, { recursive: true })
    writeFileSync(join(legacyPathDir, 'bsk.exe'), 'legacy unknown command')
    const legacyVariant = `${legacyPathDir.replaceAll('/', '\\')}\\`
    const activeVariant = `${first.pathDir.replaceAll('/', '\\')}\\`
    const systemPath = 'C:/Windows/System32/'
    environment.Path = `"${legacyVariant}";"${activeVariant}";${systemPath}`

    const second = installDesktopPnpmRuntime(options(stateDir, 'win32', environment))

    expect(second.pathDir).toBe(first.pathDir)
    expect(environment.Path).toBe(`${second.pathDir};${systemPath}`)
    second.dispose()
    expect(environment.Path).toBe(`"${legacyVariant}";"${activeVariant}";${systemPath}`)
  })

  it.runIf(process.platform === 'win32')('reclaims PATH precedence from an inherited Desktop terminal shim', () => {
    const root = temporaryDirectory()
    const stateDir = join(root, 'runtime')
    const pathDir = join(stateDir, 'bin')
    const terminalShimDir = join(root, 'terminal', 'bin')
    const captureEntry = join(root, 'capture.mjs')
    const captureOutput = join(root, 'capture.txt')
    mkdirSync(terminalShimDir, { recursive: true })
    writeFileSync(join(terminalShimDir, 'pnpm.cmd'), '@echo inherited terminal shim failed\r\n@exit /b 90\r\n')
    writeFileSync(captureEntry, [
      "import { writeFileSync } from 'node:fs'",
      "writeFileSync(process.argv.at(-1), 'host runtime')",
      '',
    ].join('\n'))
    const environment: NodeJS.ProcessEnv = {
      Path: `${terminalShimDir};${pathDir};${process.env.Path ?? ''}`,
      PATHEXT: process.env.PATHEXT,
      SystemRoot: process.env.SystemRoot,
    }
    const original = { ...environment }

    const installation = installDesktopPnpmRuntime({
      ...options(stateDir, 'win32', environment),
      appExecutable: process.execPath,
      pnpmBinPath: captureEntry,
    })
    const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', [
      '/d',
      '/s',
      '/c',
      `pnpm "${captureOutput}"`,
    ], {
      encoding: 'utf8',
      env: environment,
      shell: false,
      windowsVerbatimArguments: true,
    })

    expect(result.error).toBeUndefined()
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(readFileSync(captureOutput, 'utf8')).toBe('host runtime')
    installation.dispose()
    expect(environment).toEqual(original)
  })

  it.runIf(process.platform === 'win32')('runs a non-ASCII packaged path under an OEM console code page', () => {
    const root = temporaryDirectory()
    const stateDir = join(root, 'runtime')
    // CP437 ships with every Windows install and is not UTF-8, so it decodes the shim's UTF-8 path
    // bytes into a directory that cannot exist. A Latin-1 name keeps the fixture free of any
    // dependency on East Asian code page tables.
    const packagedRoot = join(root, 'DSH café')
    const captureEntry = join(packagedRoot, 'capture.mjs')
    const captureOutput = join(root, 'capture.txt')
    const codePageHarness = join(root, 'oem-console.cmd')
    mkdirSync(packagedRoot, { recursive: true })
    writeFileSync(captureEntry, [
      "import { writeFileSync } from 'node:fs'",
      "writeFileSync(process.argv.at(-1), 'host runtime')",
      '',
    ].join('\n'))
    // vitest's own console is inherited here, so the harness restores whatever it was started with.
    writeFileSync(codePageHarness, [
      '@echo off',
      `for /f "tokens=2 delims=:" %%c in ('chcp') do set "ORIGINAL=%%c"`,
      'chcp 437>nul',
      'call pnpm %*',
      'set "RESULT=%errorlevel%"',
      'chcp %ORIGINAL% >nul',
      'exit /b %RESULT%',
      '',
    ].join('\r\n'))
    const environment: NodeJS.ProcessEnv = {
      Path: process.env.Path ?? process.env.PATH,
      PATHEXT: process.env.PATHEXT,
      SystemRoot: process.env.SystemRoot,
    }

    const installation = installDesktopPnpmRuntime({
      ...options(stateDir, 'win32', environment),
      appExecutable: process.execPath,
      pnpmBinPath: captureEntry,
    })
    const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', [
      '/d',
      '/s',
      '/c',
      `${basename(codePageHarness)} "${captureOutput}"`,
    ], {
      cwd: root,
      encoding: 'utf8',
      env: environment,
      shell: false,
      windowsVerbatimArguments: true,
    })

    expect(result.error).toBeUndefined()
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(readFileSync(captureOutput, 'utf8')).toBe('host runtime')
    installation.dispose()
  })

  it('reuses an exact immutable generation without rewriting it', () => {
    const stateDir = join(temporaryDirectory(), 'runtime')
    const platform = process.platform === 'win32' ? 'win32' : 'linux'
    const originalPath = process.platform === 'win32' ? 'C:\\Windows' : '/usr/bin'
    const environment: NodeJS.ProcessEnv = { PATH: originalPath }
    const first = installDesktopPnpmRuntime(options(stateDir, platform, environment))
    const firstStat = lstatSync(first.pnpmShimPath)
    first.dispose()
    environment.PATH = `${first.pathDir}${pathDelimiter}${originalPath}`

    const second = installDesktopPnpmRuntime(options(stateDir, platform, environment))

    expect(second.pathDir).toBe(first.pathDir)
    expect(lstatSync(second.pnpmShimPath).ino).toBe(firstStat.ino)
    expect(lstatSync(second.pnpmShimPath).mtimeMs).toBe(firstStat.mtimeMs)
    expect(environment.PATH).toBe(`${first.pathDir}${pathDelimiter}${originalPath}`)
    second.dispose()
    expect(environment.PATH).toBe(`${first.pathDir}${pathDelimiter}${originalPath}`)
  })

  it('rejects symlinked state directories before changing PATH', () => {
    const root = temporaryDirectory()
    const target = join(root, 'target')
    const stateDir = join(root, 'runtime')
    mkdirSync(target)
    symlinkSync(target, stateDir)
    const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin' }

    expect(() => installDesktopPnpmRuntime(options(stateDir, 'linux', environment)))
      .toThrow('not a private directory')
    expect(environment).toEqual({ PATH: '/usr/bin' })
  })

  it('publishes a clean sibling instead of trusting a contaminated generation', () => {
    const root = temporaryDirectory()
    const stateDir = join(root, 'runtime')
    const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    const first = installDesktopPnpmRuntime(options(stateDir, 'linux', environment))
    first.dispose()
    const target = join(root, 'outside')
    writeFileSync(target, 'outside')
    rmSync(first.pnpmShimPath)
    symlinkSync(target, first.pnpmShimPath)
    const unknownExecutable = join(first.pathDir, 'bsk.exe')
    writeFileSync(unknownExecutable, 'locked or foreign')
    environment.PATH = `${first.pathDir}:/usr/bin`

    const second = installDesktopPnpmRuntime(options(stateDir, 'linux', environment))

    expect(second.pathDir).not.toBe(first.pathDir)
    expect(readdirSync(second.pathDir)).toEqual(['pnpm'])
    expect(environment.PATH).toBe(`${second.pathDir}:/usr/bin`)
    expect(readFileSync(unknownExecutable, 'utf8')).toBe('locked or foreign')
    expect(readFileSync(target, 'utf8')).toBe('outside')
    second.dispose()
  })

  it('leaves legacy unknown files untouched and excludes their directories from PATH', () => {
    const root = temporaryDirectory()
    const stateDir = join(root, 'runtime')
    const legacyPathDir = join(stateDir, 'bin')
    const legacyNodeBinDir = join(stateDir, 'private', 'node-bin')
    mkdirSync(legacyPathDir, { recursive: true })
    mkdirSync(legacyNodeBinDir, { recursive: true })
    const publicUnknown = join(legacyPathDir, 'bsk.exe')
    const privateUnknown = join(legacyNodeBinDir, 'bsk.exe')
    writeFileSync(publicUnknown, 'locked public command')
    writeFileSync(privateUnknown, 'locked private command')
    const environment: NodeJS.ProcessEnv = {
      PATH: `${legacyPathDir}:${legacyNodeBinDir}:/usr/bin`,
    }

    const installation = installDesktopPnpmRuntime(options(stateDir, 'linux', environment))

    expect(installation.pathDir).not.toBe(legacyPathDir)
    expect(environment.PATH).toBe(`${installation.pathDir}:/usr/bin`)
    expect(readFileSync(publicUnknown, 'utf8')).toBe('locked public command')
    expect(readFileSync(privateUnknown, 'utf8')).toBe('locked private command')
    installation.dispose()
  })

  it('does not attempt to delete a published generation that could still be locked', () => {
    const root = temporaryDirectory()
    const stateDir = join(root, 'runtime')
    const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    const first = installDesktopPnpmRuntime(options(stateDir, 'linux', environment))
    const firstRoot = dirname(first.pathDir)
    first.dispose()
    const originalRmSync = fs.rmSync
    const rm = vi.spyOn(fs, 'rmSync').mockImplementation((filename, rmOptions) => {
      if (filename === firstRoot) {
        throw Object.assign(new Error('locked'), { code: 'EPERM' })
      }
      return originalRmSync(filename, rmOptions)
    })
    syncBuiltinESMExports()

    let second: ReturnType<typeof installDesktopPnpmRuntime> | undefined
    try {
      second = installDesktopPnpmRuntime({
        ...options(stateDir, 'linux', environment),
        nodeVersion: '44.0.0',
      })
    } finally {
      rm.mockRestore()
      syncBuiltinESMExports()
    }

    expect(second).toBeDefined()
    expect(environment.PATH).toBe(`${second?.pathDir}:/usr/bin`)
    expect(existsSync(firstRoot)).toBe(true)
    expect(rm.mock.calls.some(([filename]) => filename === firstRoot)).toBe(false)
    second?.dispose()
  })

  it('fails loud for unsupported platforms and unsafe generated values', () => {
    const root = temporaryDirectory()
    expect(() => installDesktopPnpmRuntime(options(join(root, 'runtime'), 'aix', { PATH: '/usr/bin' })))
      .toThrow('unsupported on aix')
    expect(() => installDesktopPnpmRuntime({
      ...options(join(root, 'newline-runtime'), 'linux', { PATH: '/usr/bin' }),
      nodeVersion: '43.4.0\nmalicious',
    })).toThrow('must not contain NUL or newlines')
  })
})

describe('desktop Host dsh runtime', () => {
  it('content-addresses Windows DSH shims and reuses an exact generation', () => {
    const root = temporaryDirectory()
    const stateDir = join(root, 'runtime')
    const environment: NodeJS.ProcessEnv = { Path: 'C:\\Windows' }
    const runtimeOptions = {
      platform: 'win32' as const,
      appExecutable: 'C:\\Program Files\\DSH Desktop\\DSH Desktop.exe',
      dshBootstrapPath: 'C:\\Program Files\\DSH Desktop\\resources\\app.asar\\desktop-cli.js',
      profileName: 'web',
      homeDir: 'C:\\Users\\tester\\.dsh',
      stateDir,
      environment,
    }

    const first = installDesktopDshRuntime(runtimeOptions)
    const firstRoot = dirname(first.pathDir)
    first.dispose()
    const second = installDesktopDshRuntime(runtimeOptions)

    expect(second.pathDir).toBe(first.pathDir)
    expect(readdirSync(second.pathDir)).toEqual(['dsh.cmd'])
    expect(readdirSync(firstRoot).sort()).toEqual(['.generation.json', 'bin'])
    expect(readFileSync(second.dshShimPath, 'utf8')).toContain('set "DSH_DESKTOP_DEFAULT_PROFILE=web"')
    expectCodePagePinnedAheadOfEveryPath(readFileSync(second.dshShimPath, 'utf8'))
    second.dispose()
  })

  it.runIf(process.platform === 'win32')('makes the active profile available to Host plugin child processes', () => {
    const root = temporaryDirectory()
    const stateDir = join(root, 'runtime')
    const captureEntry = join(root, 'capture.mjs')
    const captureOutput = join(root, 'capture.json')
    const homeDir = join(root, 'Harness home')
    writeFileSync(captureEntry, [
      "import { writeFileSync } from 'node:fs'",
      'writeFileSync(process.argv[2], JSON.stringify({',
      '  args: process.argv.slice(3),',
      '  defaultProfile: process.env.DSH_DESKTOP_DEFAULT_PROFILE,',
      '  home: process.env.DSH_HOME,',
      '}))',
      '',
    ].join('\n'))
    const environment: NodeJS.ProcessEnv = { Path: process.env.PATH }
    const original = { ...environment }

    const installation = installDesktopDshRuntime({
      platform: 'win32',
      appExecutable: process.execPath,
      dshBootstrapPath: captureEntry,
      profileName: 'web',
      homeDir,
      stateDir,
      environment,
    })
    const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', [
      '/d',
      '/s',
      '/c',
      `dsh "${captureOutput}" --probe`,
    ], {
      encoding: 'utf8',
      env: environment,
      shell: false,
      windowsVerbatimArguments: true,
    })

    expect(result.error).toBeUndefined()
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(readdirSync(installation.pathDir)).toEqual(['dsh.cmd'])
    expect(JSON.parse(readFileSync(captureOutput, 'utf8'))).toEqual({
      args: ['--probe'],
      defaultProfile: 'web',
      home: homeDir,
    })
    expect(environment.Path).toBe(`${installation.pathDir};${original.Path ?? ''}`)

    installation.dispose()
    installation.dispose()
    expect(environment).toEqual(original)
  })
})
