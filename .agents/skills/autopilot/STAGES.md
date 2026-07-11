# Autopilot stages — skip checks and sub-agent briefs

One section per stage: the idempotency skip check (always run first, against live tracker state), then how the stage runs — a `Task` sub-agent brief for stages 1–4, or the inline procedure the orchestrator itself follows for the batch legs (stage 5, and stage 6's cleanup-sweep loop) — and the summary shape the run must produce. Prompts are shapes to adapt, not scripts to paste — but keep their load-bearing sentences (marked inline) intact.

Shared conventions:

- Every sub-agent (stages 1–4) is a general-purpose Claude agent with full tools.
- Every sub-agent brief ends with the same closing instruction: *"Return, as your entire final message, only the structured summary described above — no transcript, no file dumps."* The orchestrator keeps only that summary.
- `<S>` is the slice issue number throughout.

## Stage 1: Decompose

**Skip check** — the slice already has `size:task` children:

```bash
gh api "repos/{owner}/{repo}/issues/<S>/sub_issues" \
  --jq '[.[] | select([.labels[].name] | index("size:task"))] | length'
```

Non-zero → skip (record `decompose: skipped, <n> existing task children`). Zero → dispatch.

**Sub-agent brief:**

> Run the `/decompose` skill against issue `#<S>` in this repo, to completion. The slice is already triaged; produce its `size:task` children per the skill. **You are running unattended under `/autopilot`: at the skill's quiz step (Step 5), act as the approver yourself — sanity-check the granularity and dependency edges, then proceed to publish without waiting for a human.** Return a structured summary: the child issue numbers and titles created (with any `Blocked by` edges), and the parent's label transition.

**Summary shape:** `decomposed #<S> into tasks #<X>..#<Y>` + one line per child (`#<N> <title> [blocked by #<M>]`).

## Stage 2 (+3): Audit and apply

**Skip check** — a dated audit synthesis comment already exists on the slice:

```bash
gh api "repos/{owner}/{repo}/issues/<S>/comments" \
  --jq '[.[] | select(.body | startswith("## Audit synthesis ("))] | length'
```

Non-zero → skip stages 2 and 3 (record `audit: skipped, synthesis comment exists`). Zero → dispatch.

**Sub-agent brief:**

> Run the `/audit` skill against issue `#<S>` in this repo, to completion, in **auto-approve-routine mode**. `/audit`'s approval gate (its Step 9) normally walks a human through each finding; **you are running under `/autopilot`, whose invocation is the standing approval for ROUTINE findings only** — so classify each surviving finding before the gate:
>
> - **BLOCKING** — exactly these three *plan-poisoning* categories (each corrupts more than the one child it names, so a batch built on it wastes a full parallel run): (1) `oos-drift` — uncovered scope reaching OUTSIDE the slice's declared boundary (NOT named or implied by its Scope/AC); (2) a `sequencing` reversal that breaks the dependency DAG; (3) `grounding` — hallucinated API surface that a task depends on. The **tell** separating (1) from an in-boundary coverage gap: is the uncovered scope named or implied by the slice's own Scope/AC section? If yes, it is in-boundary (classify as COVERAGE-GAP below), not `oos-drift`. When genuinely unsure between those two, treat named/implied scope as a coverage gap; escalate to `oos-drift` only when the scope plausibly expands the declared boundary. For the other two categories, when unsure, classify as blocking.
> - **COVERAGE-GAP** — an `ac-uncovered` / `ac-partial` finding whose uncovered scope IS named or implied by the slice's declared Scope/AC: an *in-boundary* gap — a declared bullet with no covering task. This does NOT halt. For each such finding, pick its remedy by whether an existing sibling task is its natural home: **(a) sibling-absorb** — a sibling can be widened to cover it (e.g. an "integrations list" task also covering the integration *detail* route): land the gap yourself as a per-child `## Audit findings` body-edit note on that sibling (this is a ROUTINE per-child edit), and report it as sibling-absorbed into #<sibling>; **(b) needs-new-task** — no sibling is a natural home, the gap is a distinct cohesive chunk: do NOT create a child yourself (audit slice mode still creates none), and report it as needs-new-task so the orchestrator's surgical re-decompose sub-stage appends it. Either way, never halt.
> - **ROUTINE** — everything else (wording, coverage gaps closable by a per-child body edit, small task tweaks), **including a `sizing` finding** — a task that reads as oversized / "two tasks' worth". A `sizing` finding is local to the one child it names and self-corrects at the promotion-PR review, so record its per-child `## Audit findings` note and proceed. Do NOT halt to split a task, and do NOT create children: audit's slice mode creates none ("slice-level gaps are a `/decompose` re-decompose problem; task is a leaf"). Splitting, if ever wanted, is a `/decompose` job — never audit's.
>
> If there are **zero blocking findings**: approve every routine finding and every spec-level write yourself, and let `/audit` land its writes per its own Step 10 (per-child `## Audit findings` body edits — including any sibling-absorb coverage-gap note — the dated synthesis comment, any in-bar propagation comments). If there are **any blocking findings**: land NO writes tied to them; still land the routine writes and the synthesis comment (tag the blocking bullets clearly), then report the blockers — do not attempt to fix them.
>
> Return a structured summary: total findings by provenance; the routine findings applied (one line each: severity, provenance, claim, which child was edited); the synthesis comment URL; a `COVERAGE-GAP:` section listing each in-boundary coverage gap (the uncovered bullet verbatim, and its route — `sibling-absorb → #<sibling>` naming the note you landed, or `needs-new-task` with a one-line description of the task to append) — or `COVERAGE-GAP: none`; and a `BLOCKING:` section listing each blocking finding (category, claim, provenance, affected child) — or `BLOCKING: none`.

**Orchestrator decision — three-way:**

- **Any `BLOCKING:` finding → HALT** (unchanged): summarize the blockers and hand back per the SKILL.md halted-run output. Do not proceed to triage or batch.
- **Else if any `COVERAGE-GAP:` is `needs-new-task` → run Stage 3.5** (surgical re-decompose) to append the missing task(s), then proceed to stage 4. Sibling-absorb coverage gaps need no sub-stage — audit already landed the note — so just record them in the checkpoint.
- **Else → proceed to stage 4.**

In the two non-halting branches, emit the non-blocking audit-boundary checkpoint first (counts, what was auto-applied, provenance, and every coverage gap with how it was routed — sibling-absorb into #<sibling>, or needs-new-task queued for Stage 3.5) before dispatching Stage 3.5 or Stage 4.

If the audit sub-agent reports its Codex leg fell through, that is not a halt — `/audit` itself continues single-leg. Note it in the checkpoint.

## Stage 3.5: Surgical re-decompose (coverage-gap remedy, conditional)

A conditional sub-stage, **not** one of the six core stages — it does not renumber them and is absent from the pipeline skip-check table. It runs **only** when Stage 2's audit summary reported at least one `COVERAGE-GAP: needs-new-task` — an in-boundary coverage gap (a declared Scope/AC bullet with no covering task) for which no existing sibling was a natural home. Sibling-absorb gaps never reach here (audit already landed the note); a `BLOCKING:` finding never reaches here (the run already halted). It composes `/decompose`; it must not reimplement decompose's internals.

**Skip check:** skip this sub-stage entirely unless Stage 2 reported a `needs-new-task` coverage gap. There is no tracker query of its own — the trigger is the audit summary the orchestrator already holds.

**Sub-agent brief:**

> Run the `/decompose` skill against issue `#<S>` in this repo, to completion, as a **surgical, additive re-decompose**. The slice already has its `size:task` children; `/audit` found that these declared Scope/AC bullet(s) have no covering task: <list each uncovered bullet verbatim from the coverage-gap report>. Append ONLY the task(s) that cover those bullet(s) — one cohesive `size:task` child per distinct uncovered chunk. Rely on decompose's additive re-run behaviour: it preserves every existing child, skips any whose title matches, and appends only new children — so do NOT modify, re-title, close, or reorder existing tasks, and do NOT re-derive the whole decomposition. **You are running unattended under `/autopilot`: at the skill's quiz step, act as the approver yourself — sanity-check that each new task maps to an uncovered bullet, then publish without waiting for a human.** Return a structured summary: the appended child issue number(s) and title(s) (with any `Blocked by` edges), or state that no new task was appended (each uncovered bullet turned out already covered).

**Summary shape:** `re-decompose: appended #<X> <title> [blocked by #<M>]` — one line per appended child — or `re-decompose: no new task needed — <bullet> absorbed into #<sibling>` for a gap that resolved without a new child.

After this sub-stage returns, each appended child carries `size:task` + `needs-triage` (decompose's normal output), so **Stage 4's per-task triage skip check picks it up automatically** alongside any other untriaged children — no special handling. Proceed to Stage 4.

## Stage 4: Triage tasks

**Skip check** — per task. List the slice's `size:task` children and partition by the `needs-triage` label:

```bash
gh api "repos/{owner}/{repo}/issues/<S>/sub_issues" \
  --jq '.[] | select(.state == "open") | {number, title, labels: [.labels[].name]}'
```

Children without `needs-triage` are already triaged — skip them. If none carry `needs-triage`, skip the whole stage. Otherwise dispatch **one sub-agent per untriaged task, all in parallel** (one `Task` call each, same response).

**Per-task sub-agent brief:**

> Read `.agents/skills/triage/PIPELINE.md` (the autopilot-facing subset of the triage skill) and triage task issue `#<T>` in this repo per it, to completion. It is a `size:task` child of slice `#<S>`, produced by `/decompose`. **You are running unattended: where triage would confirm with a human (size verification, state choice), make the call yourself per PIPELINE.md's tables.** The expected happy path is `ready-for-agent`; if the task genuinely warrants a non-happy-path state (`needs-info`, `ready-for-human`, …), apply it honestly — do not force `ready-for-agent`. Return a structured summary: the size verified (or changed), the state applied, and one sentence of reasoning.

**Orchestrator decision:** all tasks ended `ready-for-agent` (whether via this stage or already) → proceed. Any task ended elsewhere → **HALT** and report which tasks aren't ready and why — a batch run against a partially-ready slice cannot open the promotion PR, so it would be a wasted run. The user resolves those tasks and re-runs `/autopilot <S>`.

## Stage 5: Batch (runs inline in the orchestrator)

**Skip check:** none. `/batch` handles its own resume, pre-flight filtering, and DAG internally — just hand off to it. (Closed/already-shipped tasks simply aren't eligible on a re-run.)

**This stage does NOT run as a sub-agent.** The orchestrator runs `/batch #<S>` in its own loop, because batch is built to be driven from the calling agent loop and its background `Workflow` re-notifies *that* loop on completion — a settle handshake proven in the main loop but uncertain when nested inside a backgrounded `Task`. Batch already fans every task into worktree-isolated agents, so running it inline costs the orchestrator no extra context (it only ever holds batch's final summary) while removing the await/settle risk of nesting it.

**Inline procedure** — the orchestrator itself performs batch's steps:

1. Run `/batch #<S>` per the batch skill. At batch's **Step 4 approval gate**, the autopilot invocation *is* the plan approval — do not stop for a human; record the inferred DAG (waves) so it lands in the end-of-run output, then proceed.
2. Invoke the `Workflow` tool (batch's Step 5) from the orchestrator's own loop. It runs in the background; let its completion notification return to this loop, and let batch's Settle phase finish (auto-defer, reconcile, slice promotion PR, cleanup).
3. Read batch's structured `{ results, summary }` **from the completion notification's result payload** — tasks squash-merged, tasks held by code review (finding counts + PR URLs), failed/skipped tasks with reasons, deferred issues filed, and the slice promotion PR URL (or exactly why it was not opened). Do NOT `Read` the workflow's full output file into context: it duplicates the notification payload and was measured costing the orchestrator ~25K context tokens for zero new information. Open it only if the notification payload is truncated or missing a field you need.

**Report to relay:** the approved DAG plus batch's own end-of-run report content, folded into autopilot's end-of-run output.

**Orchestrator decision:** Slice PR opened → proceed to stage 6 (the cleanup sweep) if batch deferred anything, else completed-run shape. Slice PR withheld (held/failed tasks, pre-flight blockers) → **do not run stage 6** (there is no reviewable slice PR to fold cleanup into yet); this is the end of the run, not a halt-and-retry: report what batch reported, loudly, with the user's unblocking actions as the next step.

## Stage 6: Cleanup sweep (runs inline in the orchestrator)

Stage 5's batch Settle phase auto-defers the non-blocking code-review findings on merged tasks as `cleanup` sub-issues of the slice — task-sized bundles arrive **pre-triaged** (`size:task` + `ready-for-agent`; the deferrer just verified every finding against the merged code, so triage would only rubber-stamp), while bigger or murkier bundles arrive as `needs-triage`. This stage batches the ready ones (triaging only the rare `needs-triage` stragglers) onto the *same* slice PR, draining the queue so the reviewer sees the slice and its own cleanup in one diff instead of rubber-stamping a pile of `cleanup` issues later.

**Precondition:** only run this stage if stage 5 actually opened (or found already-open) the slice promotion PR. If the slice PR was withheld, skip stage 6 entirely — there is nothing to fold cleanup into.

**Skip check** — no open `cleanup` child of the slice remains in a sweepable state (`ready-for-agent` or `needs-triage`):

```bash
gh api "repos/{owner}/{repo}/issues/<S>/sub_issues" \
  --jq '[.[] | select(.state == "open") | select([.labels[].name] | index("cleanup")) | select([.labels[].name] | (index("needs-triage") or index("ready-for-agent")))] | length'
```

Zero → skip the whole stage (record `cleanup-sweep: nothing deferred`). Non-zero → run the drain loop. (Read the work-list from this live query, **not** from batch's in-memory `deferred` list — that keeps the sweep resumable across re-runs.)

**Drain-until-dry loop — the orchestrator runs this itself, capped at 3 rounds:**

```
for round in 1..3:
  1. Query the open sweepable `cleanup` children of <S> (the skip-check query above).
     If none remain → the queue is drained; STOP the loop (success).
  2. TRIAGE only the children still carrying `needs-triage` (usually none — the deferrer
     pre-triages task-sized bundles): one `/triage #<C>` sub-agent per such child, in
     parallel — identical brief to Stage 4's per-task brief. Happy path is `size:task` +
     `ready-for-agent`; honor an honest non-happy state (a cleanup that's actually
     slice-sized, or needs-info) without forcing it. Children already `ready-for-agent`
     skip straight to step 3 — do NOT spawn triage sub-agents for them.
  3. BATCH: run `/batch #<S>` inline, exactly as Stage 5 (its own Step 5 inline procedure).
     Batch's pre-flight now finds ONLY the ready cleanup tasks (every prior task is
     closed → ineligible), merges the clean ones into the slice branch (updating the open
     PR), and its Settle auto-defers any NEW cleanup-of-cleanup findings as fresh `cleanup`
     children — which the next round's step-1 query will pick up.
  4. Next round.
after the loop (drained or cap hit): gather what was swept and what remains.
```

**Load-bearing rules for this stage:**

- **The slice PR is owned by stage 5; stage 6 only augments it.** Every stage-6 batch will report its slice-PR Settle step as `alreadyExisted: true` (an update, no new PR). If a *held* cleanup task makes batch's report say "slice incomplete — PR not opened," **do not relay that as the PR being withheld** — the PR was opened in stage 5 and still stands; a held cleanup task just stays an open task-PR against the slice branch.
- **Never halt.** A cleanup task that triage moves off the happy path, or that code-review holds, is reported and left as an open issue/task-PR. The run still ends by handing back the slice PR. The severity gate (stage 2) does not apply here — these are cosmetic findings, and the human PR review is the safety net.
- **The cap is a backstop.** Convergence in 1–2 rounds is normal; 3 rounds is the termination guarantee for a pathological cleanup-of-cleanup chain. If round 3 finishes with `needs-triage`+`cleanup` children still open, stop and report them as remaining — do not loop further.

**Summary shape:** `cleanup sweep: <c> task(s) merged onto the slice PR over <rounds> round(s)` + one line per swept task (`#<C> <title>`) + a `remaining:` line listing any cleanup still open (cap hit, held by review, or triaged off the happy path) — or `remaining: none (queue drained)`.

**Orchestrator decision:** always the end of the run — proceed to the handoff (sync the local branch), then emit the completed-run output with the cleanup-sweep line filled in. The slice PR (opened in stage 5, augmented here) is the handoff; anything the sweep left open is reported, not halted on.

## Handoff: sync the local slice branch (completed runs only)

Batch pushes every squash-merge (and every cleanup merge) to the *remote* slice branch, so by the time autopilot hands back, `origin/<slice-branch>` holds the real PR head while the **local** slice branch ref is stale — the user is left on the right branch but staring at a pre-run tree. Before emitting the completed-run output, fast-forward the local checkout so what they see locally matches what the PR shows.

Run this **only on a completed run** (slice PR open). Skip it on a halted run: there may be no pushed slice state worth syncing, and the user is likely mid-fix on their own working tree — don't touch it.

```bash
# <slice-branch> is the **Integration Branch** declared in issue #<S>'s body.
git checkout <slice-branch>              # batch already leaves HEAD here; make it explicit
git fetch origin <slice-branch>
git merge --ff-only origin/<slice-branch>
```

`--ff-only` is deliberate. If the local branch carries commits that aren't on origin (the user did local work between runs), the fast-forward *refuses* rather than rewriting history — report it (`local slice branch has unpushed commits; left as-is`) and move on. A dirty working tree that blocks the checkout or merge is handled the same way: report, never `stash`/`reset`/force. The goal is to land the reviewer on the real diff, never to discard their work. Record the outcome (synced / already up to date / left as-is + why) for the completed-run output's local-checkout line.
