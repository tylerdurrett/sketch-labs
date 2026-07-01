export const meta = {
  name: 'batch-execute',
  description:
    'DAG-schedule /execute (inline) across a parent issue\'s ready sub-tasks: one worktree-isolated agent per task, each firing the moment its dependencies finish, independently code-reviewing each task and auto-shipping dependency predecessors (only when their review is clean) so dependents can build on them.',
  phases: [
    { title: 'Prep', detail: 'per task: validate, resolve base branch, explore, plan, push empty branch' },
    { title: 'Implement', detail: 'per task: clean-context agent codes each sub-section and pushes commits' },
    { title: 'Review', detail: 'per task: independent /code-review pass; auto-fixes blocking findings, gates the ship' },
    { title: 'Land', detail: 'per task: verify ACs, open PR, and ship if a dependent needs it AND review is clean' },
    { title: 'Settle', detail: 'reconcile lifecycle state, auto-defer non-blocking findings, recolor DAG, prune worktrees' },
  ],
}

// args (passed by the /batch skill after it has inferred the DAG):
// {
//   parentIssue: number,
//   tasks: [{ number, title, dependsOn: number[] }]   // dependsOn = hard + inferred edges, must be acyclic
// }
// Tolerate args arriving as a JSON-encoded string (some tool-call serializers stringify object args).
const a = typeof args === 'string' ? JSON.parse(args) : (args || {})
const tasks = a.tasks || []
const parentIssue = a.parentIssue || null

if (!tasks.length) {
  log('No ready tasks were passed to batch-execute; nothing to run.')
  return { parentIssue: (args && args.parentIssue) || null, results: [] }
}

const byNum = new Map(tasks.map((t) => [t.number, t]))

// dependents.get(T) = the tasks in this batch that depend on T.
// A task with ≥1 dependent must be shipped (squash-merged) so dependents see its code.
const dependents = new Map(tasks.map((t) => [t.number, []]))
for (const t of tasks) {
  for (const d of t.dependsOn || []) {
    if (dependents.has(d)) dependents.get(d).push(t.number)
  }
}

// Reject cycles up front — the Promise-memoized scheduler below would otherwise deadlock.
function findCycle() {
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2
  const color = new Map(tasks.map((t) => [t.number, WHITE]))
  let edge = null
  function dfs(n) {
    color.set(n, GRAY)
    for (const d of byNum.get(n).dependsOn || []) {
      if (!byNum.has(d)) continue
      const c = color.get(d)
      if (c === GRAY) {
        edge = [n, d]
        return true
      }
      if (c === WHITE && dfs(d)) return true
    }
    color.set(n, BLACK)
    return false
  }
  for (const t of tasks) if (color.get(t.number) === WHITE && dfs(t.number)) return edge
  return null
}
const cycle = findCycle()
if (cycle) {
  log(`Dependency cycle detected (#${cycle[0]} → #${cycle[1]}); aborting batch.`)
  return {
    parentIssue: (args && args.parentIssue) || null,
    error: `dependency cycle involving #${cycle[0]} and #${cycle[1]}`,
    results: [],
  }
}

// Each task is a 4-stage pipeline of sibling agents — Prep / Implement / Review / Land — relocating
// /execute's Step-7 delegation up here so the Implement stage keeps a clean context. Review is an
// independent /code-review pass (a different agent than the implementer): it auto-fixes blocking
// findings and gates the auto-ship — a predecessor with surviving blocking findings is NOT merged,
// so the scheduler cascade-skips its dependents rather than stacking on suspect code.
// State flows stage→stage via these structured returns plus origin (each stage fetches the branch).

const PREP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ready'],
  properties: {
    ready: { type: 'boolean', description: 'true iff prep succeeded and the branch is pushed' },
    baseBranch: { type: ['string', 'null'], description: 'resolved integration branch (or main)' },
    branch: { type: ['string', 'null'], description: 'the feature branch, created and pushed to origin' },
    brief: { type: ['string', 'null'], description: 'the agent brief + any contract-updating parent comments, distilled for the implementer' },
    plan: {
      type: 'array',
      description: 'ordered cohesive sub-sections, one commit each',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title'],
        properties: {
          title: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          notes: { type: ['string', 'null'] },
        },
      },
    },
    blocker: { type: ['string', 'null'], description: 'if not ready: not OPEN/ready-for-agent/size:task, size escape-hatch, or other' },
  },
}

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['done'],
  properties: {
    done: { type: 'boolean', description: 'true iff every sub-section was implemented, committed, and pushed' },
    commits: { type: 'array', items: { type: 'string' }, description: 'one line per commit, in order' },
    landedSha: { type: ['string', 'null'], description: 'origin SHA of the feature branch AFTER your final push (git ls-remote origin <branch>) — proves the commit landed' },
    baseSha: { type: ['string', 'null'], description: 'origin SHA of the base branch (git ls-remote origin <baseBranch>) — must differ from landedSha or nothing landed' },
    deviations: { type: ['string', 'null'], description: 'any deviation from the plan' },
    blocker: { type: ['string', 'null'] },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reviewed', 'blockingCount', 'fixed'],
  properties: {
    reviewed: { type: 'boolean', description: 'true iff /code-review ran to completion' },
    blockingCount: { type: 'number', description: 'BLOCKING (correctness) findings remaining AFTER the fix pass' },
    fixed: { type: 'boolean', description: 'true iff fixes were committed and pushed to the branch' },
    findings: {
      type: 'array',
      description: 'the findings that still remain after the fix pass',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'summary'],
        properties: {
          severity: { type: 'string', description: 'blocking | cleanup' },
          file: { type: ['string', 'null'] },
          line: { type: ['number', 'null'] },
          summary: { type: 'string' },
        },
      },
    },
    summary: { type: ['string', 'null'], description: 'short digest for the PR body / batch report' },
    blocker: { type: ['string', 'null'], description: 'only if the review itself could not run' },
  },
}

const LAND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'shipped'],
  properties: {
    ok: { type: 'boolean', description: 'true iff the PR was opened (and, when required, squash-merged) successfully' },
    prNumber: { type: ['number', 'null'] },
    prUrl: { type: ['string', 'null'] },
    shipped: { type: 'boolean', description: 'true iff squash-merged into the integration branch to unblock dependents' },
    blocker: { type: ['string', 'null'] },
  },
}

// Worktree branch protocol — the root-cause fix for the cross-worktree branch collision.
// Every task's four stages (Prep/Implement/Review/Land) run in SEPARATE fresh worktrees and hand the
// branch off through origin. Git allows a branch to be checked out BY NAME in only one worktree at a
// time, and a stage's worktree isn't reliably torn down before the next stage starts — so a lingering
// sibling that holds the branch name strands the next stage ("fatal: '<branch>' is already used by
// worktree ..."). The fix: NO stage ever holds the branch by name. Every stage works in DETACHED HEAD
// (HEAD pointing straight at the commit, not via the branch ref) and publishes with an explicit
// refspec. Detached HEADs at the same commit never collide, so the one-branch-per-worktree rule can
// never fire. This also immunises against a fresh worktree starting on an unrelated base commit: the
// fetch+detach lands every stage on the right tree regardless of where its worktree started.
const WORKTREE_PROTOCOL = (branch) =>
  `WORKTREE BRANCH PROTOCOL (critical — do not deviate): your worktree is fresh and may start on an unrelated commit. NEVER run \`git checkout ${branch}\` / \`git switch ${branch}\` — a named checkout locks the branch and the sibling stages in other worktrees must be able to read it (git forbids the same branch in two worktrees). Always work in DETACHED HEAD: get the code with \`git fetch origin ${branch} && git checkout --detach FETCH_HEAD\`, and publish commits with \`git push origin HEAD:${branch}\`.`

// Supply-chain lockdown is intentional on this machine (docs/agents/locked-down-npm.md). A stage must
// NEVER weaken it to get unblocked — that turns a one-task hiccup into a machine-wide security hole.
const SECURITY_NOTE =
  `SUPPLY-CHAIN LOCKDOWN (do not circumvent): this machine deliberately blocks dependency build/install scripts and packages published <7 days ago. In a fresh worktree, \`pnpm install\` prints \`ERR_PNPM_IGNORED_BUILDS\` (e.g. esbuild) and EXITS 1 — this is EXPECTED AND BENIGN, not a broken environment: the deps install fine and esbuild/vitest ship prebuilt binaries that work without their postinstall. Do not chase that exit code. Just run the package-local binaries directly — \`./node_modules/.bin/tsc --noEmit\` to typecheck, \`./node_modules/.bin/vitest run\` to test — instead of \`pnpm run <script>\` (whose pre-flight rejects the ignored-builds state). NEVER run \`pnpm config set dangerouslyAllowAllBuilds ...\`, never lower \`min-release-age\`/\`minimumReleaseAge\`, never edit \`~/.npmrc\` or the global pnpm config — a flailing agent once did this globally and silently defeated the whole lockdown. If a package TRULY needs its build script and has no prebuilt fallback, set the blocker and surface it; a human allows it per-repo (pnpm-workspace.yaml). See docs/agents/locked-down-npm.md.`

function prepPrompt(task) {
  const deps = (task.dependsOn || []).filter((d) => byNum.has(d))
  return [
    `You are the PREP stage of a /batch run for GitHub issue #${task.number} ("${task.title}"), in your own isolated git worktree.`,
    ``,
    SECURITY_NOTE,
    ``,
    `Follow the /execute skill, Steps 1–6, per its "Running under /batch" section (Prep row): validate labels, walk the parent chain to resolve the base branch — and if that integration branch (or any ancestor up to main) does not yet exist on origin, seed the whole missing chain via /execute Step 2's recursive \`ensure_integration_branch\` rather than forking the base off main (forking off main flattens the hierarchy and corrupts the later slice/feature promotion diff) — read the brief and any contract-updating parent comments, explore the codebase, and form the numbered sub-section plan. Do NOT halt for approval (skip the Step 5 halt).`,
    `\nCreate the feature branch (Step 6), but do NOT let your worktree hold it by name — sibling stages run in separate worktrees and git forbids the same branch being checked out twice. So instead of \`git checkout -b <branch>\`, resolve the base, detach onto it (\`git fetch origin <resolved-base> && git checkout --detach FETCH_HEAD\`), and create the branch ON ORIGIN ONLY with \`git push origin HEAD:refs/heads/<branch>\`. Do NOT create a local branch ref of any kind.`,
    deps.length
      ? `\nThis task depends on #${deps.join(', #')}, already squash-merged into the integration branch. Fetch the base branch fresh before branching so it includes their code.`
      : ``,
    `\nDo NOT invoke /triage and do NOT wait for a human. If the task is not OPEN + ready-for-agent + size:task, or the Step 4 size escape-hatch fires, set ready:false and return a specific blocker (do not push a branch).`,
    parentIssue
      ? `\nLIVE DAG (amber-on-start): once the branch is pushed and you are about to return ready:true — and ONLY then (a not-ready task keeps its labels untouched) — mark the task active so the parent's Sub-issue DAG lights its node amber. Run \`gh issue edit ${task.number} --remove-label ready-for-agent --add-label in-progress\` (active work has genuinely begun), then recolor the parent: \`node "$(git rev-parse --show-toplevel)/.agents/skills/dag/recolor.mjs" ${parentIssue}\`. Both are best-effort: if either errors (e.g. the parent has no DAG section — the recolor is a clean no-op then), log it and still return ready:true. Never let this block prep.`
      : ``,
    `\nReturn: ready, baseBranch, branch, brief (distilled for the implementer — the agent brief plus any contract updates from parent comments), plan (ordered sub-sections), blocker.`,
  ]
    .filter(Boolean)
    .join('\n')
}

function implPrompt(task, prep, attempt = 1) {
  return [
    `You are the IMPLEMENT stage of a /batch run for GitHub issue #${task.number} ("${task.title}"), in your own isolated git worktree. You are /execute Step 7's clean implementation agent — you do NOT need the base-branch bookkeeping, only the plan below.`,
    attempt > 1
      ? `\nRETRY: your previous attempt returned done but the branch never advanced past base on origin — the commit did NOT land. The usual cause: a brand-new file is UNTRACKED, so \`git diff HEAD\` shows nothing — that is NOT "nothing to do". You MUST \`git add -A\`, commit, then \`git push\`, and confirm the push landed before returning done.\n`
      : ``,
    `Branch: \`${prep.branch}\` (already on origin, based on \`${prep.baseBranch}\`). ${WORKTREE_PROTOCOL(prep.branch)}`,
    ``,
    SECURITY_NOTE,
    ``,
    `The contract / brief:`,
    prep.brief || '(see issue #' + task.number + ')',
    ``,
    `The plan — implement each sub-section, in order, as exactly one commit:`,
    ...(prep.plan || []).map((s, i) => `  ${i + 1}. ${s.title}${s.files && s.files.length ? ` [${s.files.join(', ')}]` : ''}${s.notes ? ` — ${s.notes}` : ''}`),
    ``,
    `For each sub-section: implement → \`pnpm typecheck\` → run the repo's lint/format scripts *only if it defines them* (skip silently if absent — don't hunt for tooling that isn't there) → run /simplify on the changes → \`git add -A\` and commit with \`<type>(<scope>): <sub-section title>\`. One commit per sub-section — do not bundle. Then push via refspec (you are in detached HEAD): \`git push origin HEAD:${prep.branch}\`.`,
    `Do NOT open a PR, touch labels, or merge. If you hit a real blocker, set done:false and return it.`,
    ``,
    `LANDING PROOF (required — skip it and your work is silently lost when this worktree is torn down): after your final push, prove the commit reached origin. Run \`git ls-remote origin ${prep.branch}\` for the landed SHA and \`git ls-remote origin ${prep.baseBranch}\` for the base SHA; they MUST differ. Report them as landedSha and baseSha.`,
    ``,
    `Return: done, commits (one line each), landedSha, baseSha, deviations, blocker.`,
  ].join('\n')
}

function reviewPrompt(task, prep, mustShip) {
  return [
    `You are the REVIEW stage of a /batch run for GitHub issue #${task.number} ("${task.title}"), in your own isolated git worktree. You did NOT write this code — review it independently.`,
    ``,
    `Branch \`${prep.branch}\` (based on \`${prep.baseBranch}\`) carries the implementation on origin. ${WORKTREE_PROTOCOL(prep.branch)}`,
    ``,
    SECURITY_NOTE,
    ``,
    `Run \`/code-review high\` over this branch's diff against \`${prep.baseBranch}\`. Classify each finding:`,
    `  - BLOCKING — a correctness bug, logic error, or contract violation introduced by this diff.`,
    `  - cleanup — a non-blocking simplification / efficiency / style improvement.`,
    ``,
    `If there are any BLOCKING findings, fix them in place (you may use \`/code-review --fix\`, or edit by hand), then \`pnpm typecheck\` → \`pnpm lint:fix\` → \`pnpm format:fix\`, commit with \`fix(review): address code-review findings\`, and push via refspec (you are in detached HEAD): \`git push origin HEAD:${prep.branch}\`. Then re-run \`/code-review high\` ONCE more to recount. Do not loop further — report whatever blocking findings still survive that single fix pass.`,
    ``,
    `Do NOT open a PR, change labels, merge, or ship.`,
    mustShip
      ? `Other batched tasks depend on #${task.number}, so any surviving BLOCKING finding will hold it back from auto-shipping and cause its dependents to be skipped — only fixes you actually push count.`
      : `No batched task depends on #${task.number}; surviving findings will be posted on its PR for a human reviewer.`,
    ``,
    `Return: reviewed, blockingCount (BLOCKING findings remaining AFTER your fix pass), fixed (did you commit+push fixes), findings (the remaining items), summary (a short digest for the PR/report), blocker (only if /code-review could not run at all).`,
  ].join('\n')
}

function landPrompt(task, prep, { canShip, mustShip, review }) {
  const findingsNote =
    review && review.summary
      ? `\n  - Fold this Review-stage digest into the PR body under a "Review notes" heading:\n${review.summary}`
      : ``
  const lines = [
    `You are the LAND stage of a /batch run for GitHub issue #${task.number} ("${task.title}"), in your own isolated git worktree.`,
    ``,
    `Branch \`${prep.branch}\` (based on \`${prep.baseBranch}\`) carries the finished, independently code-reviewed work on origin. ${WORKTREE_PROTOCOL(prep.branch)}`,
    ``,
    SECURITY_NOTE,
    ``,
    `Then follow the /execute skill's Step 7-review, Step 8, and Step 9:`,
    `  - Review the diff against \`${prep.baseBranch}\`: one commit per sub-section (plus an optional \`fix(review):\` commit from the Review stage), on-contract, no drift. Re-run \`pnpm typecheck\` (and \`pnpm test\` if the plan calls for it).`,
    `  - Step 8: re-read the agent brief on #${task.number} and verify every acceptance criterion first-hand; this populates the PR test plan.`,
    `  - Step 9: open the PR (\`Closes #${task.number}\` only when the base is main; otherwise note the integration target).${findingsNote}`,
  ]
  if (canShip) {
    lines.push(
      `\nOther batched tasks depend on #${task.number} and code-review came back clean (no blocking findings). After the PR is open and green, you MUST run /ship for #${task.number} (task tier) to squash-merge it into \`${prep.baseBranch}\` so dependents can build on it. If /ship refuses (failing checks, unresolved review), set ok:false with that blocker and shipped:false. Set shipped:true only if the squash-merge actually landed.`,
    )
  } else if (mustShip) {
    lines.push(
      `\nOther batched tasks depend on #${task.number}, BUT code-review left ${review.blockingCount} surviving blocking finding(s), so this task is HELD from auto-ship. DO NOT ship or merge. Open the PR, then post the blocking findings as a PR comment (\`gh pr comment <pr> --body "..."\`) so a human reviewer sees them inline:\n${review.findings && review.findings.length ? JSON.stringify(review.findings) : review.summary || '(see the Review stage)'}\nSet ok:true if the PR opened, and shipped:false. The batch will skip the dependents until a human resolves and ships #${task.number}.`,
    )
  } else {
    lines.push(
      `\nNo batched task depends on #${task.number}. Open the PR and STOP — do NOT ship or merge it (landing is a separate, human-reviewed step).${review && review.findings && review.findings.length ? ` Post the remaining code-review findings as a PR comment (\`gh pr comment <pr> --body "..."\`) for the reviewer.` : ``} Set shipped:false.`,
    )
  }
  lines.push(``, `Return: ok, prNumber, prUrl, shipped, blocker.`)
  return lines.join('\n')
}

function fail(num, title, blocker, skipped = false) {
  return { number: num, title, ok: false, skipped, shipped: false, commits: [], prUrl: null, prNumber: null, blocker }
}

// Promise-memoized DAG scheduler: each task fires the instant ITS specific deps resolve
// (not when a whole "wave" finishes). The runtime's concurrency cap queues excess agents.
const memo = new Map()
function run(num) {
  if (memo.has(num)) return memo.get(num)
  const task = byNum.get(num)
  const p = (async () => {
    const deps = (task.dependsOn || []).filter((d) => byNum.has(d))
    const depResults = await Promise.all(deps.map(run))

    const failed = depResults.find((r) => !r || !r.ok)
    if (failed) {
      log(`#${num} skipped — dependency #${failed.number} did not complete.`)
      return fail(num, task.title, `Dependency #${failed.number} failed or was skipped; not safe to build on it.`, true)
    }
    const idx = depResults.findIndex((r) => !r.shipped)
    if (idx !== -1) {
      return fail(num, task.title, `Dependency #${deps[idx]} reported ok but was not shipped into the integration branch; cannot build on it.`, true)
    }

    const mustShip = (dependents.get(num) || []).length > 0

    // Stage 1 — Prep (heavy: bookkeeping + plan; pushes the empty branch).
    const prep = await agent(prepPrompt(task), { label: `prep#${num}`, phase: 'Prep', isolation: 'worktree', schema: PREP_SCHEMA })
    if (!prep) return fail(num, task.title, 'Prep agent died or was skipped.')
    if (!prep.ready) return fail(num, task.title, prep.blocker || 'Prep reported not ready.')

    // Stage 2 — Implement (CLEAN: only the plan + brief + branch). We do NOT trust impl.done alone: a
    // faulty agent can write code, skip `git add/commit/push`, misread an empty `git diff HEAD`
    // (untracked files don't show) as "nothing to do", and still return done:true — stranding the
    // branch at base and silently losing the work when the worktree is torn down. Require PROOF the
    // branch advanced past base (landedSha ≠ baseSha); retry once (fresh worktree) since it's intermittent.
    let impl = null
    for (let attempt = 1; attempt <= 2; attempt++) {
      impl = await agent(implPrompt(task, prep, attempt), { label: attempt === 1 ? `impl#${num}` : `impl#${num}·retry`, phase: 'Implement', isolation: 'worktree', schema: IMPL_SCHEMA })
      if (!impl) return fail(num, task.title, 'Implement agent died or was skipped.')
      if (!impl.done) return fail(num, task.title, impl.blocker || 'Implement did not finish the plan.')
      if (impl.landedSha && impl.baseSha && impl.landedSha !== impl.baseSha) break
      if (attempt === 2)
        return fail(num, task.title, `Implement reported done but its branch never advanced past \`${prep.baseBranch}\` (landedSha=${impl.landedSha || 'none'}, baseSha=${impl.baseSha || 'none'}) — no commit landed after two attempts.`)
      log(`#${num} Implement returned done but the branch did not advance past base — retrying once.`)
    }

    // Stage 3 — Review (independent /code-review; auto-fixes blocking findings, then GATES the ship).
    const review = await agent(reviewPrompt(task, prep, mustShip), { label: `review#${num}`, phase: 'Review', isolation: 'worktree', schema: REVIEW_SCHEMA })
    if (!review) return fail(num, task.title, 'Review agent died or was skipped.')
    if (!review.reviewed) return fail(num, task.title, review.blocker || 'Review stage did not complete.')
    const reviewClean = review.blockingCount === 0
    // A predecessor a dependent needs must be CLEAN to auto-ship. Surviving blocking findings → no
    // merge; the scheduler then cascade-skips its dependents (can't build on un-shipped, suspect code).
    const canShip = mustShip && reviewClean
    const reviewBlocked = mustShip && !reviewClean

    // Stage 4 — Land (verify ACs, open PR, post findings, ship iff canShip).
    const land = await agent(landPrompt(task, prep, { canShip, mustShip, review }), { label: `land#${num}`, phase: 'Land', isolation: 'worktree', schema: LAND_SCHEMA })
    if (!land) return fail(num, task.title, 'Land agent died or was skipped.')

    return {
      number: num,
      title: task.title,
      ok: land.ok,
      skipped: false,
      shipped: land.shipped,
      reviewBlocked,
      blockingCount: review.blockingCount ?? 0,
      reviewSummary: review.summary ?? null,
      reviewFindings: review.findings || [],
      commits: impl.commits || [],
      prNumber: land.prNumber ?? null,
      prUrl: land.prUrl ?? null,
      branch: prep.branch ?? null,
      blocker: land.ok
        ? reviewBlocked
          ? `Held from auto-ship: ${review.blockingCount} blocking code-review finding(s); PR open for human review.`
          : null
        : land.blocker,
    }
  })()
  memo.set(num, p)
  return p
}

// Capture the repo's current branch BEFORE any worktree-isolated agent runs, so the
// post-run Settle phase can restore it: worktree isolation has been observed to leave
// the main worktree in detached HEAD after a run.
const startInfo = await agent(
  `Run exactly: \`git rev-parse --abbrev-ref HEAD\`. Return the single line it prints as "branch" (it is "HEAD" when detached). Do nothing else — no checkout, no edits, no fetch.`,
  { label: 'record-branch', phase: 'Prep', schema: { type: 'object', additionalProperties: false, required: ['branch'], properties: { branch: { type: 'string' } } } },
)
const startBranch = startInfo && startInfo.branch && startInfo.branch !== 'HEAD' ? startInfo.branch : null

const results = await Promise.all(tasks.map((t) => run(t.number)))

// ────────────────────────────────────────────────────────────────────────────
// Settle phase. The per-task Land agent is budget-limited and juggling many
// concerns, so the mechanical end-of-run bookkeeping it's least reliable at is
// hoisted here into dedicated, single-purpose passes with explicit checklists.
// Deterministic-where-it-can-be: each agent runs a fixed command list, not its
// own judgment, for the rote steps.
// ────────────────────────────────────────────────────────────────────────────
phase('Settle')

// ② Auto-defer. Non-blocking code-review findings on a SHIPPED task would vanish
//    with its squash-merged, now-closed PR — exactly the "auto-merge buries flagged
//    work" gap. File them as tracked `needs-triage` + `cleanup` sub-issues of the
//    slice instead. Held + open-PR tasks keep their findings on a still-open PR, so
//    they're left alone.
const DEFER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issues'],
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['number', 'title'],
        properties: {
          number: { type: 'number' },
          title: { type: 'string' },
          url: { type: ['string', 'null'] },
          covers: { type: 'array', items: { type: 'number' }, description: 'the task numbers whose findings this issue captures' },
        },
      },
    },
    dropped: { type: ['string', 'null'], description: 'short note on findings dropped because grep/Read did not confirm them, or null' },
  },
}

let deferred = []
const shippedWithFindings = results.filter((r) => r.shipped && (r.reviewFindings || []).length > 0)
if (parentIssue && shippedWithFindings.length > 0) {
  const payload = shippedWithFindings.map((r) => ({ task: r.number, pr: r.prNumber, findings: r.reviewFindings }))
  const dz = await agent(
    [
      `You are the AUTO-DEFER stage of a /batch run. The tasks below were squash-merged into slice #${parentIssue} and their PRs are now CLOSED, so the non-blocking code-review findings attached to them would be lost. Capture them as tracked issues by following the /defer skill — with ONE difference: this run is unattended, so DO NOT ask for approval (skip /defer step 4); capture by default.`,
      ``,
      `Findings, grouped by the task they were found on (JSON):`,
      JSON.stringify(payload),
      ``,
      `Steps:`,
      `  1. VERIFY each finding before filing (/defer step 2). Read slice #${parentIssue}'s body for its \`**Integration Branch:**\`, \`git fetch origin <that-branch>\`, then confirm each cited file:line at that ref WITHOUT checking it out — use \`git show origin/<branch>:<path>\` or \`git grep <pattern> origin/<branch>\` (never \`git checkout\`, which would detach the main worktree). DROP any finding that no longer matches; if all of a task's findings fail, skip that task.`,
      `  2. BUNDLE surviving findings by the seam/file they touch (/defer step 3). Findings in the same file across different tasks (a repeated footgun) belong in ONE issue. Target "one focused PR could land all of this".`,
      `  3. CREATE each issue: \`gh issue create --label needs-triage --label cleanup\`. The body MUST begin with \`**Part of:** #${parentIssue}\` (the slice — a task can't parent a task) and a \`**Surfaced by:**\` line naming the task(s) + merged PR(s). Use the /defer body template (one section per finding with clickable file:line links, a Scope, an Out of scope).`,
      `  4. LINK each new issue as a native sub-issue of #${parentIssue}: \`owner_repo=$(gh repo view --json nameWithOwner -q .nameWithOwner); cid=$(gh api repos/$owner_repo/issues/<new#> --jq .id); gh api --method POST repos/$owner_repo/issues/${parentIssue}/sub_issues -F sub_issue_id=$cid\`.`,
      `  5. Do NOT add \`size:task\` or \`ready-for-agent\` — those are deliberately left for /triage. Do NOT start any work.`,
      ``,
      `Return: issues (each {number, title, url, covers}), dropped.`,
    ].join('\n'),
    { label: 'auto-defer', phase: 'Settle', schema: DEFER_SCHEMA },
  )
  if (dz && Array.isArray(dz.issues)) deferred = dz.issues
}

// ① Reconcile + cleanup. Re-assert the lifecycle invariant the Land agent's /ship
//    is supposed to but sometimes doesn't (observed: PR merged yet issue left OPEN):
//    every shipped task ⇒ PR merged AND issue closed AND active-state labels stripped.
//    Then the one authoritative DAG recolor, and worktree/HEAD hygiene (isolation has
//    leaked worktree dirs and left the main worktree detached).
const RECONCILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['healed'],
  properties: {
    healed: { type: 'array', items: { type: 'string' }, description: 'one line per corrective action taken; empty if every invariant already held' },
    dagRecolored: { type: ['string', 'null'], description: 'the recolor.mjs output line' },
    worktreesPruned: { type: ['number', 'null'], description: 'count of leftover worktrees removed' },
    headRestored: { type: ['string', 'null'], description: 'branch checked back out, or null' },
    notes: { type: ['string', 'null'] },
  },
}
const shippedSet = results.filter((r) => r.shipped).map((r) => ({ task: r.number, pr: r.prNumber }))
let settle = null
if (parentIssue) {
  settle = await agent(
    [
      `You are the RECONCILE stage of a /batch run for slice #${parentIssue}. Run this fixed checklist of git/gh commands and HEAL any drift. Do not improvise beyond it.`,
      ``,
      `1. LIFECYCLE INVARIANT — for each shipped task below: confirm its PR is MERGED (\`gh pr view <pr> --json state,mergedAt,baseRefName\`), then confirm its issue is CLOSED. If a merged task's issue is still OPEN, heal it: \`gh issue edit <task> --remove-label ready-for-agent --remove-label in-progress\`, then \`gh issue close <task> --comment "Shipped via #<pr> (squash-merged into <baseRefName>). Will reach \\\`main\\\` when parent #${parentIssue} ships upward."\`. If a PR is NOT merged though the task was marked shipped, do NOT close it — record that in notes.`,
      `   Shipped tasks (JSON): ${JSON.stringify(shippedSet)}`,
      `2. DAG — recolor the parent once, authoritatively: \`node "$(git rev-parse --show-toplevel)/.agents/skills/dag/recolor.mjs" ${parentIssue}\`. Relay its output (a clean no-op when there's no "## Sub-issue DAG" section).`,
      `3. WORKTREES — clean this run's isolation leftovers: \`git worktree prune\`, then for every path under \`.claude/worktrees/\` still in \`git worktree list\`, run \`git worktree remove --force <path>\`. Count how many you removed.`,
      `4. HEAD — check \`git rev-parse --abbrev-ref HEAD\`. ${startBranch ? `If it prints "HEAD" (detached), restore the pre-run branch: \`git checkout ${startBranch}\`.` : `If it prints "HEAD" (detached), record the detached SHA in notes — no pre-run branch was captured, so do NOT guess one.`}`,
      ``,
      `Return: healed (one line per corrective action, empty array if nothing needed fixing), dagRecolored, worktreesPruned, headRestored, notes.`,
    ].join('\n'),
    { label: 'reconcile', phase: 'Settle', schema: RECONCILE_SCHEMA },
  )
}

const opened = results.filter((r) => r.ok && !r.shipped && !r.reviewBlocked).map((r) => r.number)
const shipped = results.filter((r) => r.shipped).map((r) => r.number)
const heldForReview = results.filter((r) => r.reviewBlocked)
const failed = results.filter((r) => !r.ok)

if (settle && Array.isArray(settle.healed) && settle.healed.length > 0) {
  log(`Reconcile healed ${settle.healed.length} drifted item(s): ${settle.healed.join(' · ')}`)
}
log(
  `Done: ${opened.length} PR(s) opened for review, ${shipped.length} predecessor(s) squash-merged to unblock dependents, ${heldForReview.length} held from auto-ship by code-review, ${failed.length} failed/skipped, ${deferred.length} finding(s) deferred to new issue(s).`,
)

return {
  parentIssue: parentIssue,
  results,
  summary: {
    opened,
    shipped,
    heldForReview: heldForReview.map((r) => ({
      number: r.number,
      prNumber: r.prNumber,
      blockingCount: r.blockingCount,
      reviewSummary: r.reviewSummary,
    })),
    failed: failed.map((f) => ({ number: f.number, blocker: f.blocker })),
    deferred,
    reconciled: settle
      ? { healed: settle.healed || [], worktreesPruned: settle.worktreesPruned ?? null, headRestored: settle.headRestored ?? null, notes: settle.notes ?? null }
      : null,
  },
}
