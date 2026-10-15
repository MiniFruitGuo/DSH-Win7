/** Host entrypoint started by the Desktop supervisor. No BrowserWindow or Electron main APIs load here. */
import { installFailLoud } from '@deepseek-ai/dsh-app-boot'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { inspect } from 'node:util'
import { createLaunchEnvironmentSnapshot, type LaunchEnvironmentLayerInput } from '@deepseek-ai/dsh-launch-environment'
import { desktopProxyEnvLookup } from './system-proxy.ts'
import { HostRpc, type HostPort } from './host-rpc.ts'
import { createHostRuntime, type RuntimeSnapshot } from './host-runtime-bridge.ts'
import { bootDesktopHost, type DesktopHostOptions } from './host-bootstrap.ts'
import { createDesktopBrowserAccess } from './desktop-browser-access.ts'
import { DesktopLanHttpsRuntime } from './lan-https-runtime.ts'
import type { DesktopStartupGenerationHost } from './startup-generation.ts'
import { disableAsarArchiveView } from './asar-archive-policy.ts'
import { DESKTOP_PACKAGE_NAME } from './product-identity.ts'

// The Host lists and reads user workspaces; see asar-archive-policy.ts.
disableAsarArchiveView(import.meta.url)

/**
 * Control channel over the supervisor's stdio pipes.
 *
 * Electron's `utilityProcess` would hand this process a `parentPort`, but it runs the child on
 * Electron's embedded Node — 16 in the Windows 7 shell, which cannot load DSH at all. The
 * supervisor therefore starts this file with the packaged Node 22 and the two ends speak
 * newline-delimited JSON over stdin/stdout. `stdout` belongs to the protocol, so ordinary logging
 * is redirected to stderr, which the supervisor forwards into the Desktop log.
 * @returns the port the control channel runs on.
 */
function stdioPort(): HostPort {
  const receivers: ((message: unknown) => void)[] = []
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim().length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line) as unknown
      } catch (cause) {
        process.stderr.write(`dsh-plugin-desktop: discarding malformed supervisor message: ${cause instanceof Error ? cause.message : String(cause)}\n`)
        continue
      }
      for (const receive of receivers) receive(parsed)
    }
  })
  return {
    send: message => { process.stdout.write(`${JSON.stringify(message)}\n`) },
    listen: receive => {
      receivers.push(receive)
      return () => {
        const at = receivers.indexOf(receive)
        if (at !== -1) receivers.splice(at, 1)
      }
    },
  }
}

const port = stdioPort()
// `stdout` carries the control protocol, so application logging belongs on stderr — which the
// supervisor forwards into the Desktop log. Writing straight to stderr avoids depending on whichever
// `Console` implementation the surrounding runtime installed.
const logToStderr = (...args: unknown[]): void => {
  process.stderr.write(`${args.map(value => (typeof value === 'string' ? value : inspect(value))).join(' ')}\n`)
}
console.log = logToStderr
console.info = logToStderr
/**
 * Report boot progress on stderr.
 *
 * A Host that dies or stalls during composition leaves the supervisor waiting on `boot` with no
 * indication of how far it got: the process is a child with its own log file, and a stalled compose
 * logs nothing at all. These markers make the last completed step readable in the Desktop log and in
 * any captured stderr.
 * @param name - stage identifier, stable enough to grep for in a report.
 * @param detail - optional one-line detail.
 */
const stage = (name: string, detail?: string): void => {
  process.stderr.write(`dsh-plugin-desktop: host stage=${name}${detail === undefined ? '' : ` ${detail}`}\n`)
}
const rpc = new HostRpc(port, 120_000)
let host: DesktopStartupGenerationHost | undefined
let inspectServices = () => ({ aaRuntime: false, aaOnboarding: false })
rpc.handle('status', () => ({ pid: process.pid, services: inspectServices() }))
let starting = false
let stopping = false
let lan: DesktopLanHttpsRuntime | undefined
let releaseProxy: (() => Promise<void>) | undefined
let releaseTask: Promise<void> | undefined
/** Tear this generation down once, whether the supervisor asked or a fatal error forces it. */
const release = (): Promise<void> => releaseTask ??= (async () => {
  stopping = true
  await host?.fiber.dispose()
  await lan?.stop()
  await releaseProxy?.()
  releaseProxy = undefined
})()
rpc.handle('stop', release)
// A utility process only warns on an unhandled rejection and keeps serving from whatever state
// the failure left, so adopt the same fail-loud contract as the Desktop main process and the
// upstream CLI: report, release what this generation holds, exit 1. The supervisor then sees an
// unexpected exit and keeps this stderr diagnostic in the Desktop log.
installFailLoud(DESKTOP_PACKAGE_NAME, process, release)
rpc.handle('boot', async args => {
  const [wire, snapshot, token] = args as [Omit<DesktopHostOptions, 'desktopLaunchEnvironment'> & { launchEnvironmentLayers: LaunchEnvironmentLayerInput[] }, RuntimeSnapshot, string]
  const options: DesktopHostOptions = { ...wire, desktopLaunchEnvironment: createLaunchEnvironmentSnapshot(wire.launchEnvironmentLayers) }
  if (starting || stopping) throw new Error('DSH Host generation already started or stopped')
  starting = true
  stage('boot-request')
  // The supervisor's installation does not reach here: the global dispatcher, `proxyRouteFor`'s
  // backing state, and the child-process environment are all module-private per process. This must
  // land before `bootDesktopHost`, because plugins mount during boot and may request immediately.
  // The supervisor already logged which route this is and why; repeating the URL here would only
  // add a second place for it to appear in a log a user pastes into an issue.
  releaseProxy = await installProxyFromEnvironment(
    desktopProxyEnvLookup(options.desktopLaunchEnvironment, options.desktopProxyOverlay),
    message => process.stderr.write(`dsh-plugin-desktop: ${message}\n`),
  )
  process.stderr.write('dsh-plugin-desktop: host outbound proxy policy installed\n')
  stage('proxy-ready')
  try {
    const runtime = createHostRuntime(rpc, snapshot)
    const browser = createDesktopBrowserAccess(options.prepared.mode === 'compatibility' && options.prepared.openBrowser, token)
    lan = new DesktopLanHttpsRuntime({
      addresses: options.prepared.lanAddresses, requestedPort: 0,
      prepareCertificate: () => rpc.call('certificate'),
    })
    stage('compose-begin')
    inspectServices = await bootDesktopHost(options, runtime, browser, lan,
      value => { host = value }, code => { void rpc.call('quit', [code]).catch(() => {}) })
    stage('compose-done')
    if (stopping) { await host?.fiber.dispose(); throw new Error('DSH Host stopped during startup') }
    await runtime.mountScheduled()
    stage('mounted')
    return { pid: process.pid }
  } catch (cause) {
    // A generation that never booted gets no `stop`, so release here or the policy outlives it.
    stage('failed', cause instanceof Error ? cause.message : String(cause))
    await releaseProxy?.()
    releaseProxy = undefined
    throw cause
  }
})
