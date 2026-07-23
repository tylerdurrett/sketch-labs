import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

export const PENCIL_CONTOUR_REVISION =
  'b6147366448d37021e20d48326045a6cba3039ca'
export const WATERCOLOR_FORMS_REVISION =
  '4d6f085706350fbf03a1da6f7c00721896c72fb4'

const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const execFile = promisify(execFileCallback)

export const workspaceRoot = fileURLToPath(
  new URL('../../../..', import.meta.url),
).replace(/\/$/, '')

const GROUPS = Object.freeze({
  flowingContoursProduction: Object.freeze({
    roots: Object.freeze([
      'packages/core/src/sketches/flowing-contours',
    ]),
    include: (path) => path.endsWith('.ts'),
  }),
  pencilContourComparator: Object.freeze({
    roots: Object.freeze(['packages/core/src/sketches/pencil-contour']),
    include: (path) => path.endsWith('.ts'),
  }),
  watercolorFormsComparator: Object.freeze({
    roots: Object.freeze(['packages/core/src/sketches/watercolor-forms']),
    include: (path) => path.endsWith('.ts'),
  }),
  referenceContract: Object.freeze({
    roots: Object.freeze([
      'packages/core/src/__tests__/flowing-contours-reference-fixtures.test.ts',
      'packages/core/src/__tests__/flowing-contours-reference-gates.test.ts',
      'packages/core/src/__tests__/flowing-contours-reference-metrics.test.ts',
      'packages/core/src/__tests__/helpers/flowingContoursReferenceCases.ts',
      'packages/core/src/__tests__/helpers/flowingContoursReferenceMetrics.ts',
    ]),
    include: () => true,
  }),
  studioDecoder: Object.freeze({
    roots: Object.freeze([
      'apps/studio/src/imageAssetIdentity.ts',
      'apps/studio/src/imageAssetResolver.ts',
    ]),
    include: () => true,
  }),
  preparationTool: Object.freeze({
    roots: Object.freeze([
      'apps/studio/scripts/lib/flowing-contours-reference-provenance.mjs',
      'apps/studio/scripts/prepare-flowing-contours-reference.mjs',
    ]),
    include: () => true,
  }),
  browserPin: Object.freeze({
    roots: Object.freeze([
      '.agents/skills/chrome-devtools/scripts/package.json',
      '.agents/skills/chrome-devtools/scripts/package-lock.json',
    ]),
    include: () => true,
  }),
})

async function git(args) {
  const { stdout = '' } = await execFile('git', args, {
    cwd: workspaceRoot,
    maxBuffer: 20 * 1024 * 1024,
  })
  return stdout.trim()
}

export async function resolveCommit(commit, label = 'commit') {
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error(`${label} must be a lowercase 40-character SHA`)
  }
  let resolved
  try {
    resolved = await git(['rev-parse', '--verify', `${commit}^{commit}`])
  } catch {
    throw new Error(`${label} is not available: ${commit}`)
  }
  if (resolved !== commit) {
    throw new Error(`${label} did not resolve exactly to ${commit}`)
  }
  return resolved
}

async function isAncestor(ancestor, descendant) {
  try {
    await git(['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch (error) {
    if (error?.code === 1) return false
    throw error
  }
}

async function listedFiles(command, revision, group) {
  const output = await git([
    command,
    ...(command === 'ls-tree'
      ? ['-r', '--name-only', revision]
      : []),
    '--',
    ...group.roots,
  ])
  return output === ''
    ? []
    : output
        .split('\n')
        .filter(group.include)
        .sort()
}

async function fileHashes(paths) {
  return Promise.all(
    paths.map(async (path) => ({
      path,
      sha256: createHash('sha256')
        .update(await readFile(`${workspaceRoot}/${path}`))
        .digest('hex'),
    })),
  )
}

function aggregateHash(files) {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.sha256)
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function cleanSnapshot(name, commit) {
  const group = GROUPS[name]
  const committed = await listedFiles('ls-tree', commit, group)
  const current = await listedFiles('ls-files', '', group)
  if (committed.length === 0) {
    throw new Error(`${name} has an empty protected inventory at ${commit}`)
  }
  if (JSON.stringify(committed) !== JSON.stringify(current)) {
    throw new Error(`${name} tracked inventory differs from ${commit}`)
  }

  const status = await git([
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    ...group.roots,
  ])
  if (status !== '') {
    throw new Error(`${name} has dirty protected paths:\n${status}`)
  }
  const diff = await git([
    'diff',
    '--name-only',
    commit,
    '--',
    ...current,
  ])
  if (diff !== '') {
    throw new Error(`${name} content differs from ${commit}:\n${diff}`)
  }
  const files = await fileHashes(current)
  return Object.freeze({
    revision: commit,
    algorithm: 'sha256(file bytes); aggregate sha256(path + NUL + hash + NUL)',
    files: Object.freeze(files.map(Object.freeze)),
    aggregateSha256: aggregateHash(files),
  })
}

/**
 * Refuse capture unless every production, comparator, contract, decoder, tool,
 * and browser-pin input is both clean and byte-identical to its stated commit.
 */
export async function flowingContoursReferenceProvenance(
  preparationCommit,
) {
  await resolveCommit(preparationCommit, 'preparation commit')
  const head = await git(['rev-parse', 'HEAD'])
  if (!(await isAncestor(preparationCommit, head))) {
    throw new Error('preparation commit must be an ancestor of HEAD')
  }
  for (const [revision, label] of [
    [PENCIL_CONTOUR_REVISION, 'Pencil Contour comparator revision'],
    [WATERCOLOR_FORMS_REVISION, 'Watercolor Forms comparator revision'],
  ]) {
    await resolveCommit(revision, label)
    if (!(await isAncestor(revision, head))) {
      throw new Error(`${label} must be an ancestor of HEAD`)
    }
  }

  return Object.freeze({
    preparationCommit,
    head,
    flowingContoursProduction: await cleanSnapshot(
      'flowingContoursProduction',
      preparationCommit,
    ),
    pencilContourComparator: await cleanSnapshot(
      'pencilContourComparator',
      PENCIL_CONTOUR_REVISION,
    ),
    watercolorFormsComparator: await cleanSnapshot(
      'watercolorFormsComparator',
      WATERCOLOR_FORMS_REVISION,
    ),
    referenceContract: await cleanSnapshot('referenceContract', head),
    studioDecoder: await cleanSnapshot('studioDecoder', head),
    preparationTool: await cleanSnapshot('preparationTool', head),
    browserPin: await cleanSnapshot('browserPin', head),
  })
}

export async function primaryCheckoutRoot() {
  const commonDirectory = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  return commonDirectory.replace(/\/\.git\/?$/, '')
}
