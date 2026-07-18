# Photo Scribble fine-budget visual attestation — 2026-07-18

- Reviewer: Codex (`easy-auto/336-budget-screen` block 6)
- Reference: each scenario's named `current-fine-baseline` Fill, Tone, and
  Outline captures in this campaign.
- Review scale: original 1000 × 1000 capture and the frozen 200 × 200 mm Plot
  Profile.
- Verdict vocabulary: `better`, `equal`, or `worse`, exactly as frozen in the
  protocol. A single `worse` rejects a candidate.

| Scenario / candidate | Tone target faithfulness | Routing legibility | Letterbox permission | Alpha permission | Geometry/export parity | Plot readiness |
| --- | --- | --- | --- | --- | --- | --- |
| flowers / fine-100k | better | better | equal | equal (opaque fixture) | equal | better |
| pinecone / fine-100k | better | better | equal | equal | equal | better |
| flowers / fine-250k | better | better | equal | equal (opaque fixture) | equal | worse |
| pinecone / fine-250k | better | worse | equal | equal | equal | worse |

The 100k captures add recognizable structure without a visible permission or
parity regression. The 250k flowers capture resolves more of the target but
produces dense tangles that no longer preserve clean drawable separation at the
fixed physical profile. The 250k pinecone fills the silhouette more completely,
but heavy black routing obscures scale structure visible in the Tone reference;
that is both a routing-legibility and plot-readiness regression. No capture
places marks in the square-frame contain-fit bands or outside the pinecone's
visible alpha silhouette. Fill/Outline capture pairs remain visually congruent,
and their raw records prove Scene/export primitive parity.
