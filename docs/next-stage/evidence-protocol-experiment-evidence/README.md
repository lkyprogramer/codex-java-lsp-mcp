# Evidence protocol experiment evidence

Four stages completed. Engineering checks and data audits pass; the original QA 80% gate remains FAIL. See `stage-state.json`, `p3/result.json`, and `p4/result.json`.

`p1`–`p3` contain raw test/benchmark logs, source bindings and reviews. `p4` contains the frozen 72+24 plan, launcher, offline evidence, model summaries and independent audits. `p4/model-raw.tar.gz` contains full and diagnostic raw model requests/responses, tool results, source snapshots, attempt candidates, judge results and frozen scores. Only rebuildable MCP caches are excluded. Its member hashes are in `p4/model-raw-manifest.json`; extract under `p4` to restore those two directories. Original uncompressed evidence and isolated compiled candidates remain at the recorded local paths.

The scripts and raw reports preserve original absolute candidate paths. Replaying an audit on this host uses the recorded candidate; relocating it requires restoring that exact source tree and updating only audit path resolution, never the raw scores, model plan or source facts. `commands.json` records the executed principal commands. No new model requests are needed to inspect these results. Do not re-run the launcher into an existing output directory.

`immutable-input-hashes.json` binds 293 pre-existing historical/scoring files. `final-integrity.json` verifies them unchanged and binds the final executable source. This directory's `manifest.json` hashes every delivered evidence file other than itself. No credentials are included.
