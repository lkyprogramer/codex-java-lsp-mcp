# java_impact warm optimization test report (2026-06-29)

## Patch

- Changed files: `src/agent-router/index.ts`, `src/agent-router.test.ts`.
- Behavior changed: `semanticPolicy=auto` skips semantic verify when semantic seed was skipped in the same routing attempt.
- Behavior intentionally not changed: `semanticPolicy=required`, `mode=precision`, `mode=recall`, cold routing, MCP public tool options, benchmark JSON schema, and Task 3/4/5 graph expansion.

## Before / After

| project | warmState | before P95 | after P95 | before R_read_must | after R_read_must | timeout logs |
|---|---|---:|---:|---:|---:|---:|
| lishuedu | cold-nolsp | 67.61 | 68.02 | 1.0000 | 1.0000 | 0 |
| lishuedu | warm-auto | 1654.92 | 73.86 | 1.0000 | 1.0000 | 0 |
| lishuedu | warm-required | 1733.73 | 1716.87 | 1.0000 | 1.0000 | 0 |
| cipherlink | cold-nolsp | 33.66 | 30.09 | 1.0000 | 1.0000 | 0 |
| cipherlink | warm-required | 1519.60 | 1518.34 | 1.0000 | 1.0000 | 0 |
| exam-parent-v3 | cold-nolsp | 28.74 | 27.10 | 1.0000 | 1.0000 | 0 |
| exam-parent-v3 | warm-required | 1505.19 | 1504.99 | 1.0000 | 1.0000 | 0 |

## SLO Decision

| Gate | Target | Result | Pass |
|---|---:|---:|---:|
| warm-auto no-semantic P95 | <=300ms | 73.86ms | true |
| warm-required first-touch P95 | <=800ms | 1716.87ms | false |
| warm-required cache-hit P50 | <=100ms | 8.00ms | true |
| timeout logs | 0 | 0 | true |
| R_read_must | 1.0000 | 1.0000 | true |

Profile-aware warm remains blocked because `warm-required` first-touch P95 is still above the absolute `800ms` gate in all three real repos. The patch removes the `warm-auto` no-seed fixed cost, but it does not solve first-touch `textDocument/references` latency.

## Final Test Report

| Check | Command | Result |
|---|---|---|
| Build | `npm run build` | PASS: TypeScript build and build-stamp generation completed with exit code 0. |
| Unit tests | `npm test` | PASS: 64 tests, 60 pass, 4 skip, 0 fail. |
| lishuedu warm matrix | `node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state <cold-nolsp/warm-auto/warm-required> --strategy impact --runs 5 --verbosity diagnostic` | PASS: cold `R_read_must=1.0000`; warm-auto P95 `73.86ms`; warm-required P95 `1716.87ms`; timeout logs `0`. |
| cipherlink warm matrix | `node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state <cold-nolsp/warm-required> --strategy impact --runs 5 --verbosity diagnostic` | PASS: cold `R_read_must=1.0000`; warm-required P95 `1518.34ms`; timeout logs `0`. |
| exam warm matrix | `node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state <cold-nolsp/warm-required> --strategy impact --runs 5 --verbosity diagnostic` | PASS: cold `R_read_must=1.0000`; warm-required P95 `1504.99ms`; timeout logs `0`. |
