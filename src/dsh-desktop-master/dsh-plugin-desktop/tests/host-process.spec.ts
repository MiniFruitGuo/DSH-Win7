import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import type { DesktopStartupGenerationHost } from '../src/startup-generation.ts'
const state = vi.hoisted(() => ({ spawn: vi.fn() }))
// The Host is a packaged Node process, so the supervisor reaches it through
// node:child_process instead of Electron's utilityProcess.
vi.mock('node:child_process', () => ({ spawn: state.spawn }))
import {
  formatUnexpectedHostExit, HOST_STDERR_TAIL_CHARS, startIsolatedDesktopHost,
  type IsolatedHostExit, type IsolatedHostOptions,
} from '../src/host-process.ts'

interface SentMessage { kind: string; id: number; method?: string }

function fixture(respond = true) {
  const sent: SentMessage[] = []
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    kill: vi.fn(() => { queueMicrotask(() => child.emit('exit', 0, null)); return true }),
  })
  // Answer the newline-delimited JSON protocol the supervisor speaks over stdio.
  if (respond) {
    child.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim().length === 0) continue
        const message = JSON.parse(line) as SentMessage
        sent.push(message)
        if (message.kind === 'call') {
          child.stdout.write(`${JSON.stringify({ kind: 'result', id: message.id, value: { pid: 123 } })}\n`)
        }
      }
    })
  }
  state.spawn.mockReturnValue(child)
  let host!: DesktopStartupGenerationHost
  const onFailure = vi.fn()
  const options = {
    host: { desktopLaunchEnvironment: createLaunchEnvironmentSnapshot([]) },
    runtime: { platform: 'win32', locale: 'en', updates: { currentVersion: '2.0.7-beta.1' } },
    rendererToken: 'fixture', prepareCertificate: async () => ({ failureCode: 'fixture' }),
    bindHost: (value: DesktopStartupGenerationHost) => { host = value }, requestQuit() {}, onFailure,
  } as unknown as IsolatedHostOptions
  return { child, sent, options, onFailure, host: () => host }
}

it('starts the packaged Node with piped stdio instead of an Electron utility process', async () => {
  const f = fixture()
  await startIsolatedDesktopHost(f.options)
  await f.host().fiber.dispose()
  expect(state.spawn).toHaveBeenCalledWith(
    expect.any(String),
    [expect.stringContaining('host-process-entry.js')],
    expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }),
  )
})
it('binds the child before startup and makes repeated teardown idempotent', async () => {
  const f = fixture()
  await startIsolatedDesktopHost(f.options)
  await Promise.all([f.host().fiber.dispose(), f.host().fiber.dispose()])
  expect(f.child.kill).toHaveBeenCalledOnce()
  expect(f.onFailure).not.toHaveBeenCalled()
  expect(f.sent.filter(message => message.method === 'stop')).toHaveLength(1)
})
it('reports unexpected Host exit without automatically relaunching or replaying work', async () => {
  const f = fixture()
  await startIsolatedDesktopHost(f.options)
  f.child.emit('exit', 9, null)
  expect(f.onFailure).toHaveBeenCalledOnce()
  await f.host().fiber.dispose()
  expect(f.child.kill).not.toHaveBeenCalled()
})
it('carries the exit code and how long the Host lived, so a code 0 is not read as a clean exit', async () => {
  const f = fixture()
  await startIsolatedDesktopHost(f.options)
  f.child.emit('exit', 0, null)
  const [error, exit] = f.onFailure.mock.calls[0] as [Error, { exitCode: number; uptimeMs: number }]
  expect(error.message).toContain('DSH Host exited (0)')
  expect(exit.exitCode).toBe(0)
  expect(exit.uptimeMs).toBeGreaterThanOrEqual(0)
  expect(Number.isFinite(exit.uptimeMs)).toBe(true)
})
it('names the signal when the Host was terminated rather than exiting on its own', async () => {
  const f = fixture()
  await startIsolatedDesktopHost(f.options)
  f.child.emit('exit', null, 'SIGTERM')
  const [error, exit] = f.onFailure.mock.calls[0] as [Error, { exitCode: number }]
  expect(error.message).toContain('DSH Host exited (signal SIGTERM)')
  expect(exit.exitCode).toBe(1)
})
it('takes a spawn failure down as a channel error instead of an unhandled event', async () => {
  const f = fixture(false)
  const start = startIsolatedDesktopHost(f.options)
  queueMicrotask(() => { f.child.emit('error', new Error('spawn node.exe ENOENT')) })
  await expect(start).rejects.toThrow(/failed to start|channel closed/u)
})
it('leaves a Desktop-requested teardown off the unexpected-exit record', async () => {
  const f = fixture()
  await startIsolatedDesktopHost(f.options)
  await f.host().fiber.dispose()
  expect(f.onFailure).not.toHaveBeenCalled()
})
it('keeps what a fatal Host said last, since its stderr is otherwise never persisted', async () => {
  const f = fixture()
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    await startIsolatedDesktopHost(f.options)
    f.child.stderr.emit('data', Buffer.from('x'.repeat(HOST_STDERR_TAIL_CHARS)))
    // A multibyte character split across two chunks must not turn into replacement characters.
    const euro = Buffer.from('€')
    f.child.stderr.emit('data', Buffer.concat([Buffer.from('dsh: fatal load failure: boom '), euro.subarray(0, 1)]))
    f.child.stderr.emit('data', euro.subarray(1))
    f.child.emit('exit', 1, null)
  } finally { vi.restoreAllMocks() }
  const [error, exit] = f.onFailure.mock.calls[0] as [Error, IsolatedHostExit]
  expect(exit.stderrTail).toHaveLength(HOST_STDERR_TAIL_CHARS)
  expect(exit.stderrTail.endsWith('dsh: fatal load failure: boom €')).toBe(true)
  expect(formatUnexpectedHostExit(error, exit))
    .toBe(`DSH Host exited (1); restart the application to reconnect\nLast DSH Host stderr:\n${exit.stderrTail}`)
})
it('logs only the exit reason when the Host wrote nothing', () => {
  const error = new Error('DSH Host exited (0); restart the application to reconnect')
  expect(formatUnexpectedHostExit(error, { exitCode: 0, uptimeMs: 1, stderrTail: '\n' })).toBe(error.message)
})
