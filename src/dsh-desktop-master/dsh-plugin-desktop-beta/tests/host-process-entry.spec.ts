import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DESKTOP_PACKAGE_NAME } from '../src/product-identity.ts'

type EntryProcess = { noAsar?: boolean }
const entryProcess = process as unknown as EntryProcess
const processEvents: EventEmitter = process
type FatalEvent = 'unhandledRejection' | 'uncaughtException'
const fatalEvents: FatalEvent[] = ['unhandledRejection', 'uncaughtException']
let preexisting = new Map<FatalEvent, Set<(...args: unknown[]) => void>>()
let restoreStdin: (() => void) | undefined

/** Listeners the entry installed on this test worker's own process; they must not outlive the test. */
function installedListeners(event: FatalEvent): Array<(...args: unknown[]) => void> {
  const before = preexisting.get(event) ?? new Set()
  return (processEvents.listeners(event) as Array<(...args: unknown[]) => void>).filter(listener => !before.has(listener))
}

/**
 * Stand in for the supervisor's stdio pipes.
 *
 * The entry reads newline-delimited JSON from stdin and answers on stdout, so the fixture swaps in
 * a writable stream that can emit those frames and captures what the entry writes back.
 */
function fakeStdio() {
  const stdin = Object.assign(new EventEmitter(), { setEncoding: vi.fn(), resume: vi.fn(), pause: vi.fn() })
  const frames: Record<string, unknown>[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim().length === 0) continue
      frames.push(JSON.parse(line) as Record<string, unknown>)
    }
    return true
  })
  const descriptor = Object.getOwnPropertyDescriptor(process, 'stdin')
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true, writable: true })
  restoreStdin = () => { if (descriptor !== undefined) Object.defineProperty(process, 'stdin', descriptor) }
  return { stdin, frames, send: (data: unknown) => { stdin.emit('data', `${JSON.stringify(data)}\n`) } }
}

beforeEach(() => {
  preexisting = new Map(fatalEvents.map(event => [event, new Set(processEvents.listeners(event) as Array<(...args: unknown[]) => void>)]))
})

afterEach(() => {
  for (const event of fatalEvents) for (const listener of installedListeners(event)) processEvents.off(event, listener)
  vi.restoreAllMocks()
  restoreStdin?.()
  restoreStdin = undefined
  delete entryProcess.noAsar
  vi.resetModules()
})

it('reads user workspaces physically and listens on the stdio control channel', async () => {
  const stdio = fakeStdio()
  delete entryProcess.noAsar

  await import('../src/host-process-entry.ts')

  expect(entryProcess.noAsar).toBe(true)
  expect(stdio.stdin.setEncoding).toHaveBeenCalledWith('utf8')
  expect(stdio.stdin.listenerCount('data')).toBeGreaterThan(0)
})

it('keeps application logging off the protocol stream', async () => {
  fakeStdio()
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

  await import('../src/host-process-entry.ts')
  console.log('plugin said hello')

  expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('plugin said hello')
})

it('fails loud on an unhandled rejection instead of serving on in a broken state', async () => {
  // Node only prints a warning for an unhandled rejection and keeps running.
  const stdio = fakeStdio()
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

  await import('../src/host-process-entry.ts')
  const [onRejection, ...others] = installedListeners('unhandledRejection')
  expect(others).toHaveLength(0)
  onRejection?.(new Error('host boom'), Promise.resolve())

  await vi.waitFor(() => { expect(exit).toHaveBeenCalledWith(1) })
  const written = stderr.mock.calls.map(([chunk]) => String(chunk)).join('')
  expect(written).toContain(`${DESKTOP_PACKAGE_NAME}: fatal load failure: `)
  expect(written).toContain('host boom')
  // The generation was released before exit, so it refuses to boot again.
  stdio.send({ kind: 'call', id: 1, method: 'boot', args: [{ launchEnvironmentLayers: [] }, {}, 'token'] })
  await vi.waitFor(() => {
    expect(stdio.frames).toContainEqual({ kind: 'result', id: 1, error: 'DSH Host generation already started or stopped' })
  })
})
