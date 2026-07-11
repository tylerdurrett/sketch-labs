---
name: easy-auto
description: Orchestrate a slice-sized issue through decomposition, iterative plan review, parallel worktree execution, independent code review, and a final pull request using sub-agents. Use when the user says "/easy-auto", asks to complete a whole slice without separate task issues or PRs, or wants context-preserving sub-agent orchestration.
disable-model-invocation: true
---

I will provide a slice-sized issue.

Rather than using the full workflow that involves creating separate issues and PRs for each task, please handle the whole slice yourself. You should act as orchestrator, and put all work out to sub agents.

First, have an agent decompose the slice into a DAG of individual tasks that are one story point and self contained.

Then, you have an agent review that planned DAG of work to ensure it's coherent and meets the full intent of issue 110. If there are issues, have an agent update/review the plan. Repeat until you have a reviewed plan that is acceptable.

Again, my goal is for you to preserve your context window and act as orchestrator, so sub agents do the work.

Next, delegate the work of completing the plan to sub agents as needed, parallelizing what you can and using worktrees.

Each block of work will need to be reviewed by an indpendent agent. Check for correctness, codebase hygiene and best practices, and make sure the intent of the block of work is achieved.

Send back to a sub agent to fix any issues, and repeat until the block of work passes.

Once everything comes back, review ALL the work against the original stated goals from the parent issue. Send back to agents as needed until it's ready for a PR.

Open the pr and leave me on a branch for the PR so I can review. 

You know how to best structure the agent delegations so I'll leave the details of that to you.
