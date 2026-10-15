import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { localPluginTargetsAsFiles } from '../src/pnpm.ts'

/** A real directory, because the rewrite only engages on paths that exist. */
function directory(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-plugin-target-'))
}

describe('localPluginTargetsAsFiles', () => {
  it('rewrites an absolute directory target to file:', () => {
    const dir = directory()
    expect(localPluginTargetsAsFiles(['add', dir])).toEqual(['add', `file:${dir}`])
  })

  it('rewrites the target and keeps switches untouched', () => {
    const dir = directory()
    expect(localPluginTargetsAsFiles(['add', '--save-dev', dir]))
      .toEqual(['add', '--save-dev', `file:${dir}`])
  })

  it('leaves an npm package target alone', () => {
    expect(localPluginTargetsAsFiles(['add', 'dsh-computer-use@0.3.2']))
      .toEqual(['add', 'dsh-computer-use@0.3.2'])
  })

  it('leaves a scoped npm target alone', () => {
    expect(localPluginTargetsAsFiles(['add', '@deepseek-ai/dsh-base@1.2.3']))
      .toEqual(['add', '@deepseek-ai/dsh-base@1.2.3'])
  })

  it('leaves an already-qualified file: target alone', () => {
    const dir = directory()
    expect(localPluginTargetsAsFiles(['add', `file:${dir}`]))
      .toEqual(['add', `file:${dir}`])
  })

  it('leaves an existing link: target alone, so a broken record is not silently rewritten', () => {
    expect(localPluginTargetsAsFiles(['add', 'link:C:/somewhere/else']))
      .toEqual(['add', 'link:C:/somewhere/else'])
  })

  it('leaves a relative specifier alone', () => {
    expect(localPluginTargetsAsFiles(['add', './some/relative/path']))
      .toEqual(['add', './some/relative/path'])
  })

  it('leaves an absolute path that is not a directory alone', () => {
    const dir = directory()
    const file = join(dir, 'package.tgz')
    writeFileSync(file, 'not a directory')
    expect(localPluginTargetsAsFiles(['add', file])).toEqual(['add', file])
  })

  it('leaves an absolute path that does not exist alone', () => {
    const missing = resolve(directory(), 'absent-package')
    expect(localPluginTargetsAsFiles(['add', missing])).toEqual(['add', missing])
  })

  it('does not touch any other subcommand', () => {
    const dir = directory()
    mkdirSync(join(dir, 'x'), { recursive: true })
    expect(localPluginTargetsAsFiles(['remove', dir])).toEqual(['remove', dir])
    expect(localPluginTargetsAsFiles(['list'])).toEqual(['list'])
  })

  it('returns a copy, so a caller cannot mutate the input through it', () => {
    const argv = ['add', 'dsh-computer-use@0.3.2']
    const result = localPluginTargetsAsFiles(argv)
    result.push('extra')
    expect(argv).toEqual(['add', 'dsh-computer-use@0.3.2'])
  })
})
