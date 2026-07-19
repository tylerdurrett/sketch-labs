---
name: auto-feature
description: Orchestrate a feature-sized issue, where each sub issue will itself be delegated using the easy-auto skill. This should ONLY be called by the user, and it should only be used on a feature sized issue or a specific list of slice sized issues.
disable-model-invocation: true
---

The user will provide either an entire feature issue or a specific list of issues belonging to a feature. If the user wants you to implement the entire feature, you will first read each sub issue under the feature issue and create a DAG of the sub issues so you know how to delegate the work. If the user provides specific sub issues they want to work on, you should still determine the shape of the DAG so you can delegate them safely.

Now, I want you to act as orchestrator. You should delegate the implementation of each of these issues to sub agents. Tell each sub agent to itself use the easy-auto skill on its particular issue. So each sub agent you delegate to will further delegate to a nested sub agent (that's what easy-auto calls for). You yourself will not use easy-auto or do any implementation work. However, you should get up to speed to understand the work so you can manage appropriately, and you should report back when the agents finished so I can understand what was done. Each sub agent may attempt to set its finished work to the current git branch - that might not quite work, but at the end I'll need to review each item individually so we can work on letting me preview the branches then.

Any parallel sub agents you create to work on individual slices should be able to communicate with each other if needed so they can coordinate in cases where they think they might risk overlapping or conflicting work.

Get up to speed and then proceed to orchestrate the development of the issues the user provided. Do not do more than the user requested. If they gave you specific set of issues, do those only.