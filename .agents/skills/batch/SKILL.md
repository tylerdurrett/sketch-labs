---
name: batch
description: Spawn sub-agents to /execute each sub-issue under a parent GitHub issue, running independent ones in parallel and dependent or code-overlapping ones sequentially. Use when the user wants to batch-execute the sub-issues of a parent issue (e.g. "/batch issue 35").
---

Use sub agents to `/execute` each of the sub issues under the given parent issue. If any would depend on each other or touch the same code do them separately, otherwise do in parallel
