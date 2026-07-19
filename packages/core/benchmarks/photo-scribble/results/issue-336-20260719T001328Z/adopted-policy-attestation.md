# Issue 336 adopted production policy attestation

Campaign `issue-336-20260719T001328Z` confirms the adopted production tuple
`1,000,000 / 16,000 / 32,000 / 16,000` for both fixed fine, high-density
photographic fixtures. The registered production resolver selected that exact
complete tuple. Separate injected runs produced identical identity, Scene, and
diagnostics hashes, and the frozen centered target hashes did not change.

Two independent production measurements per fixture reproduced the exact Scene
and diagnostics hashes. Each recorded one source/model preparation and one
solver pass through a fresh real DedicatedWorker. Canvas Fill and Outline,
ordinary SVG, normalized plotter SVG coordinates, and PNG evidence all passed
their exact parity checks; direct cancellation acknowledged without a late
replacement. Both jobs completed below the 300-second hard machine boundary
without a browser/Worker crash, OOM, transfer, Canvas, export, or protocol
failure.

The tone gamma mapping remains unchanged at exponent range `[0.5, 2]`. This
gate confirms the budget adoption only; it makes no tone-policy change.

The flowers production measurements took 27.87 s and 27.97 s. The pinecone
measurements took 18.52 s and 18.48 s. Heartbeat gaps remain observations under
the maintainer machine-ceiling override: flowers reached 1.53 s and 1.56 s
during large result transfer, while pinecone remained below 0.84 s. All
terminal-to-display and cancellation limits passed.

## Evidence-integrity correction

The first committed harness serialized `preparationCount: 1` for every path
instead of reporting the executor's actual calls. The two measured production
runs per fixture remain one preparation and one solver pass. The equivalence
production path is corrected to two preparations and one solver pass because it
runs the registered generator, then separately resolves the tuple and target;
the injected equivalence path remains one preparation and one solver pass. No
geometry, hash, timing, capture, or adoption result changed.
