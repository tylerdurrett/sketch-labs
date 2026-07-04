---
name: autopilot
description: Take an already-triaged `size:slice` issue all the way from decomposition to a batched slice promotion PR, autonomously. Composes the existing skills — `/decompose`, `/audit` (auto-approving routine findings, halting on blocking ones), and `/triage` across the task children as fresh sub-agents, then `/batch` inline — with tracker state as the interface so re-runs resume where they left off. Use when the user says "/autopilot 35", "autopilot slice 35", or "take slice 35 through to batch".
---

# Autopilot

Run one triaged `size:slice` issue through the whole slice lifecycle — decompose → audit (+apply) → triage the tasks → batch — without stopping for routine approvals. The run ends where `/batch` ends: every code-review-clean task squash-merged into the slice branch and one slice promotion PR opened for human review.

**Thin orchestrator, not a reimplementation.** Every stage runs the existing skill; this skill never duplicates their logic. `/decompose`, `/audit`, `/triage`, and `/batch` stay the single source of truth for their steps — if this document and one of theirs ever disagree about how a stage works internally, theirs wins.

**Every stage's output is tracker state (GitHub issues, labels, comments, bodies), not in-memory data.** That is what makes the composition robust: each stage reads its input from the tracker and writes its output back, so the pipeline gets idempotency and resumability for free — re-running `/autopilot <S>` after any failure skips completed stages via the per-stage skip checks and picks up where the tracker says it stopped.

**Stages 1–4 are fresh sub-agents; stage 5 (batch) runs inline.** For stages 1–4, dispatch a `Task` sub-agent (a general-purpose Claude agent with full tools); it runs the existing skill to completion and returns a short structured summary as its final message, so the orchestrator stays a lean coordinator holding only each stage's summary plus the go/no-go decision — main context must NOT accumulate the full decompose + audit + triage payload. Stage 5 is the deliberate exception: the orchestrator runs `/batch #<S>` **inline, in its own loop**, because `/batch` is designed to be driven from the calling agent loop ("the orchestration is decided here, by the calling agent") and its background `Workflow` re-notifies the *calling* loop on completion — a settle mechanism that is proven in the main loop but uncertain when nested inside a backgrounded `Task` sub-agent. The context-leanness reason for sub-agenting the other stages does not apply to batch: batch already fans every task into worktree-isolated agents itself, so the orchestrator only ever holds batch's final summary regardless. Sub-agenting it would add await/settle risk for zero isolation benefit.

**Autonomy is severity-gated, not blind.** Routine audit findings are auto-applied and the run proceeds; blocking / structural findings halt the run and hand control back to the user. See [the severity gate](#the-severity-gate).

## Hard rules

- **Triaged slices only.** The input must be an open `size:slice` issue that `/triage` already processed. Anything else stops at the precondition guard — this skill never triages or grills the slice itself.
- **Compose, never reimplement.** Each stage invokes the existing skill. No stage logic is duplicated here.
- **The severity gate is non-negotiable.** A blocking finding (any of the four categories) halts the run before batch. There is no flag to override it.
- **Stages 1–4 run as sub-agents; stage 5 (batch) runs inline.** For stages 1–4 never run the skill inline in the orchestrator and never carry a stage's full working payload past its summary. Stage 5 is the one exception — `/batch` must be driven from the orchestrator's own loop so its background `Workflow`'s completion notification returns to the calling loop (proven in the main loop, uncertain inside a nested `Task`), and it adds no context cost since batch isolates every task itself.
- **Never merge the slice promotion PR.** `/batch` opens it in review-first mode; the human review of that PR is the safety net that makes routine auto-apply acceptable. Autopilot ends when the PR opens (or when batch reports why it couldn't).

## Step 0: Precondition guard

Resolve the argument to an issue number (`35`, `#35`, or a full issue URL) and fetch it:

```bash
gh issue view <S> --json number,title,state,labels,body
```

Mirror `/triage`'s own definition of a triaged slice (its Verification table: `needs-triage` off, `ready-for-agent` or `in-progress` on, `**Integration Branch:**` prepended). All of these must hold:

- `state` is `OPEN`.
- Labels include `size:slice`.
- Labels do **not** include `needs-triage` and do **not** include `needs-grilling`.
- The body contains an `**Integration Branch:**` line (the declaration `/triage` prepends).

If any check fails, **STOP** — do not run any stage. Tell the user which check failed and point them at `/triage #<S>` (or `/grill-with-docs #<S>` for `needs-grilling`). Triage — and any optional grilling — is the one step that stays manual, before `/autopilot` is invoked.

## The pipeline

Five stages, linear. Each has an idempotency skip check (read from the tracker). When not skipped, stages 1–4 run as fresh sub-agents and stage 5 runs inline in the orchestrator (see the principle above for why). Per-stage skip checks, sub-agent briefs (stages 1–4), the inline batch procedure (stage 5), and summary shapes live in [STAGES.md](STAGES.md) — read it before running a stage.

| # | Stage        | Runs                                                  | Skip when (tracker state)                                        |
| - | ------------ | ----------------------------------------------------- | ---------------------------------------------------------------- |
| 1 | Decompose    | `/decompose #<S>`                                     | The slice already has `size:task` children                       |
| 2 | Audit        | `/audit #<S>` in auto-approve-routine mode            | A dated `## Audit synthesis (…)` comment already exists on `<S>` |
| 3 | Apply        | (inside the audit sub-agent — `/audit`'s own Step 10) | Skipped whenever stage 2 is skipped                               |
| 4 | Triage tasks | `/triage #<T>` per untriaged task child, sub-agents in parallel | Per task: the child no longer carries `needs-triage`     |
| 5 | Batch        | `/batch #<S>`                                         | Never — batch handles its own resume/DAG internally; just hand off |

Stage 3 is listed separately because it is a distinct autonomy decision, but it executes inside the stage-2 sub-agent: `/audit` today gates every write on explicit user approval, so autopilot invokes it with the orchestrator's mandate standing in as the approver — auto-approve ROUTINE findings (the audit lands those writes itself, per its Step 10), escalate BLOCKING ones (no writes for those; halt instead).

After each stage returns (a sub-agent's summary for stages 1–4, batch's own end-of-run report for the inline stage 5), verify it reports success, keep only that summary, and decide go / halt. On any stage failure (sub-agent error, malformed summary, skill refusal, batch error), halt and report — the next `/autopilot <S>` run resumes from that stage via the skip checks.

## The severity gate

The heart of the autonomy design. During the audit stage, every surviving finding is classified:

- **Routine** — wording fixes, coverage gaps closable by a per-child body edit, a task that needs a small tweak. Auto-apply (per-child `## Audit findings` body edits, the synthesis comment, in-bar propagation comments) and proceed. No human pause.
- **Blocking / structural** — the plan itself is wrong. Exactly four categories:
  1. A "task" that is actually slice-sized.
  2. Slice scope drift — the audit found uncovered scope that changes the slice's boundary.
  3. A sequencing reversal that breaks the DAG.
  4. Hallucinated API surface that a task depends on.

When any blocking finding surfaces: **HALT**. Summarize the blocking finding(s) — claim, provenance, which child, why it's structural — and return control to the user. Do not proceed to the triage or batch stages. When genuinely unsure which side a finding falls on, treat it as blocking — a halt costs a re-run; a batch on a broken plan costs a full parallel execution.

Why routine findings can auto-proceed: the downstream safety net. Every task inside `/batch` gets an independent code review, and the run ends in a slice promotion PR the user reviews before anything reaches the feature branch. The severity halt doesn't exist to protect correctness — the PR gate does that — it exists to avoid wasting a full parallel batch run on a structurally broken plan.

**Non-blocking checkpoint.** Whether or not anything blocked, emit a short summary at the audit boundary — findings counts, what was auto-applied, provenance — before dispatching stage 4. A user who is watching can interrupt there; one who isn't is not required to.

## Resumability

Free, via tracker state. Every stage writes its output to the tracker, and every stage's skip check reads the tracker — so re-running `/autopilot <S>` after any failure (a crashed sub-agent, a network error, a deliberate interrupt, a blocking-finding halt the user has since resolved) skips the completed stages and resumes at the first incomplete one. There is no autopilot-private state file to reconcile.

## End-of-run output

Three-block template per [docs/agents/output-format.md](../../../docs/agents/output-format.md).

Completed run — relay the batch stage's report as the substance:

```
Autopiloted slice #<S>: decomposed into <n> tasks, audited (<r> routine findings auto-applied), <t> tasks triaged, batch run complete — <shipped> task(s) landed on the slice branch, slice promotion PR opened.

- 🚀 Slice promotion PR (review-first — this is your review gate): <url>
- audit synthesis: <comment url>
- <any held/failed/skipped tasks, deferred issues, or skipped stages, one line each>

> Next step: review the slice PR <url> and merge it (or `/ship #<S>`) to promote the slice.
```

Halted run (blocking finding, failed stage, or tasks that didn't reach `ready-for-agent`):

```
Autopilot halted on slice #<S> at the <stage> stage: <one-sentence reason>.

- <blocking finding summary with provenance and the affected child> · ...
- completed before the halt: <stages, one clause each>

> Next step: <the human action that unblocks — e.g. resolve the blocking finding on #<T>>. Then re-run `/autopilot #<S>` — completed stages will be skipped.
```

Be loud about anything that landed without a human pause (auto-applied findings, auto-merged tasks — relaying batch's own loudness) and about the slice PR, opened or withheld. Never let autonomy be a surprise.

## What this skill does NOT do

- It does not triage or grill the input slice. That first step stays manual — the precondition guard enforces it.
- It does not reimplement any stage. It dispatches the existing skills and relays their reports.
- It does not apply blocking audit findings, or proceed past them. It halts and hands back.
- It does not merge the slice promotion PR, and it does not promote anything upward. `/batch` opens the PR; the user reviews and merges it.
- It does not run on features, initiatives, tasks, or untriaged slices.
