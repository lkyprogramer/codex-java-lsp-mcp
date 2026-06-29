# java_impact warm instrumentation report (2026-06-29)

## Summary

- First bottleneck: `session.textDocument/references`, largest aggregate phase is `28326ms` in `lishuedu warm-auto`.
- warm-auto no-semantic fixed cost: `semantic.used=false`, but `semantic.verifyUsed=true`; `session.textDocument/references` dominates and P95 is `1654.92ms`.
- warm-required first-touch miss: `session.textDocument/references` dominates all three real repos; P95 is `1733.73ms` for lishuedu, `1519.60ms` for cipherlink, and `1505.19ms` for exam-parent-v3.
- Defaultability decision: blocked. `warm-auto` violates the `<=300ms` no-semantic P95 gate, all `warm-required` runs violate the `<=800ms` first-touch P95 gate, and lishuedu emitted one `textDocument/implementation` timeout log.

## Commands

```bash
npm run build
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/warm-inst-lishuedu-cold.json 2> /tmp/warm-inst-lishuedu-cold.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state warm-auto --strategy impact --runs 5 --verbosity diagnostic > /tmp/warm-inst-lishuedu-auto.json 2> /tmp/warm-inst-lishuedu-auto.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state warm-required --strategy impact --runs 5 --verbosity diagnostic > /tmp/warm-inst-lishuedu-required.json 2> /tmp/warm-inst-lishuedu-required.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/warm-inst-cipherlink-cold.json 2> /tmp/warm-inst-cipherlink-cold.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state warm-required --strategy impact --runs 5 --verbosity diagnostic > /tmp/warm-inst-cipherlink-required.json 2> /tmp/warm-inst-cipherlink-required.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/warm-inst-exam-cold.json 2> /tmp/warm-inst-exam-cold.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state warm-required --strategy impact --runs 5 --verbosity diagnostic > /tmp/warm-inst-exam-required.json 2> /tmp/warm-inst-exam-required.err
```

## Results

| project | warmState | prepareWarmMs | elapsed P50 | elapsed P95 | top phase | timeout log | R_read_must | recall |
|---|---|---:|---:|---:|---|---:|---:|---:|
| lishuedu | cold-nolsp | 0 | 6.54 | 67.61 | `rg 283ms` | false | 1.0000 | 0.7756 |
| lishuedu | warm-auto | 3193 | 1511.43 | 1654.92 | `session.textDocument/references 28326ms` | false | 1.0000 | 0.7756 |
| lishuedu | warm-required | 20522 | 10.59 | 1733.73 | `session.textDocument/references 13168ms` | true | 1.0000 | 0.8256 |
| cipherlink | cold-nolsp | 0 | 1.69 | 33.66 | `rg 102ms` | false | 1.0000 | 0.7885 |
| cipherlink | warm-required | 16425 | 4.64 | 1519.60 | `session.textDocument/references 12790ms` | false | 1.0000 | 0.8171 |
| exam-parent-v3 | cold-nolsp | 0 | 1.69 | 28.74 | `rg 98ms` | false | 1.0000 | 0.5217 |
| exam-parent-v3 | warm-required | 9439 | 2.21 | 1505.19 | `session.textDocument/references 8265ms` | false | 1.0000 | 0.5883 |

## Root Cause

The observed dominant phase is `session.textDocument/references`.

For `warm-auto`, semantic seed is not used, but semantic verification still runs once the warm session reports idle. The slow attempts are single `textDocument/references` requests around the `1500ms` timeout budget, so the cost is not explained by local ranking, rg, or warm preparation alone.

For `warm-required`, the same `textDocument/references` first-touch request dominates P95 across all three repos. `textDocument/implementation` is a secondary issue: it produced one timeout log in lishuedu and contributes to the worst lishuedu attempt, but it is not the largest aggregate phase.

## Decision

- `warm-auto`: optimize semantic request policy first. The measured defect is that auto mode can run verify even when seed semantic was skipped; the next patch should skip auto semantic verification unless semantic seed was actually used.
- `warm-required`: keep blocked for default/profile-aware warm. The dominant cost is a single slow `textDocument/references` call per attempt, not a multi-request queue; bounded concurrency would not address the measured P95 shape.
- `R_read_must`: remains `1.0000` in all cold real-repo benchmarks, so Task 3/4/5 graph expansion remains untriggered.

## Final Test Report

| Check | Command | Result |
|---|---|---|
| Build | `npm run build` | PASS: TypeScript build and build-stamp generation completed with exit code 0. |
| Unit tests | `npm test` | PASS: 63 tests, 59 pass, 4 skip, 0 fail. |
| lishuedu cold hard gate | `node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic` | PASS: `R_read_must=1.0000`, recall `0.7756`, P95 `67.61ms`. |
| cipherlink cold hard gate | `node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic` | PASS: `R_read_must=1.0000`, recall `0.7885`, P95 `33.66ms`. |
| exam cold hard gate | `node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic` | PASS: `R_read_must=1.0000`, recall `0.5217`, P95 `28.74ms`. |
| warm timeout logs | `rg "Timed out waiting|textDocument/.+failed" /tmp/warm-inst-*.err` | FAIL: one lishuedu `textDocument/implementation` timeout log was observed in `warm-required`. |
