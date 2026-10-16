/**
 * Make a locally installed plugin land inside the Profile instead of pointing at it.
 *
 * `pnpm add <absolute-directory>` records the dependency as `link:<dir>` — a projection that points
 * at that directory rather than installing it. The package is then never copied into the Profile,
 * and the Profile contract requires packages to resolve *within* its own `node_modules`
 * (`package-overlay.ts`: a resolved manifest outside `<profile>/node_modules` is rejected). So the
 * next launch fails during profile composition with
 *
 *     cannot resolve package "<name>" from the Desktop installation or active Profile
 *
 * and the application stops in recovery. It is not specific to Windows 7 — it fails anywhere the
 * package lives outside the Profile — but that is where it was found, because that is where plugins
 * are installed from a local directory.
 *
 * `file:<dir>` makes pnpm copy the package into its store and hoist a real directory into the
 * Profile, which is exactly what an npm-installed plugin looks like. It is also entirely local, so
 * it keeps working with no network.
 *
 * The rewrite has to happen in `@deepseek-ai/dsh-plugin-manager`, not in the Desktop shell: the
 * plugin-manager runs inside the Host process and reaches pnpm through its own CLI path, so a
 * Desktop-side interception never sees these arguments.
 *
 * Patched at packaging time because `deepseek-harness/` is a pinned upstream submodule that must not
 * be edited. Keep in step with `localPluginTargetsAsFiles` in `src/pnpm.ts`, which covers the same
 * problem on the Desktop-side path.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Marker so a second run over the same tree is a no-op. */
const MARKER = 'dsh-desktop: local plugin targets are installed as file:'

/** The function whose return value becomes pnpm's positional install target. */
const ANCHOR_SIGNATURE = 'export function anchorPathSpec(argument, cwd) {'

const INJECTED = `${ANCHOR_SIGNATURE}
    ${MARKER}
    if (!argument.startsWith('-') && !/^(?:file|link):/.test(argument) && isAbsolute(argument)) {
        try {
            if (existsSync(join(argument, 'package.json'))) return \`file:\${argument}\`;
        }
        catch { /* an unreadable path is left for pnpm to report */ }
    }`

/** Files whose contents were rewritten. */
export interface PluginTargetPatchReport {
  readonly rewritten: readonly string[]
}

/**
 * Rewrite the plugin-manager's path anchoring so local directory installs become `file:`.
 * @param applicationRoot - the packaged `resources/app` directory.
 * @returns which files changed.
 */
export function installLocalPluginTargetPatch(applicationRoot: string): PluginTargetPatchReport {
  const target = join(
    applicationRoot,
    'node_modules',
    '@deepseek-ai',
    'dsh-plugin-manager',
    'lib',
    'types',
    'operations.js',
  )
  let text: string
  try {
    text = readFileSync(target, 'utf8')
  } catch {
    return { rewritten: [] }
  }
  if (text.includes(MARKER)) return { rewritten: [] }
  if (!text.includes(ANCHOR_SIGNATURE)) return { rewritten: [] }
  writeFileSync(target, text.replace(ANCHOR_SIGNATURE, INJECTED), 'utf8')
  return { rewritten: [target] }
}
