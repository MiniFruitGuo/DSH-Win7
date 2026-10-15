/** Node-mode trampoline for the upstream Windows ACL runner. */

import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ensureWindowsConsoleHost } from './windows-console-host.ts'

const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'
const RUNNER_FAILURE_EXIT = 127
const RUNNER_SIGNATURE = 'windows-acl-run'
// `import.meta.resolve` needs Node 20.6, but this trampoline also runs under the
// Electron 22 runtime on Windows 7 (Node 16.17.1), so fall back to require.
const ACL_REQUIRE = createRequire(import.meta.url)
const META_RESOLVE = (import.meta as { resolve?: (specifier: string) => string }).resolve
const ACL_RUNNER_PATH = typeof META_RESOLVE === 'function'
  ? fileURLToPath(META_RESOLVE.call(import.meta, '@deepseek-ai/dsh-sandbox-windows-acl/runner'))
  : ACL_REQUIRE.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner')

function removeRunAsNodeEnvironment(): void {
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase() === RUN_AS_NODE) delete process.env[key]
  }
}

async function main(): Promise<void> {
  const requestedRunner = process.argv[2]
  removeRunAsNodeEnvironment()
  const expectedRunner = ACL_RUNNER_PATH
  if (requestedRunner !== expectedRunner) {
    throw new Error('desktop trampoline received an unexpected ACL runner')
  }
  ensureWindowsConsoleHost()
  process.argv = [process.argv[0] as string, expectedRunner, ...process.argv.slice(3)]
  await import(pathToFileURL(expectedRunner).href)
}

void main().catch((cause: unknown) => {
  const detail = cause instanceof Error ? cause.message : String(cause)
  process.stderr.write(`${RUNNER_SIGNATURE}: desktop trampoline: ${detail}\n`)
  process.exitCode = RUNNER_FAILURE_EXIT
})
