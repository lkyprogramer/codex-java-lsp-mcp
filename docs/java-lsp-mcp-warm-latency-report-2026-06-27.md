# java_impact warm latency baseline (2026-06-27)

## Summary

本报告只记录 warm-auto / warm-required 延迟事实，不改变 router 行为，不扩大 warm-auto 覆盖，也不做 profile-aware warm。

结论：

- `warm-required` 在三个真实项目上均保持 `R_read_must=1.0000`，且本轮未观察到 `textDocument/implementation` timeout 日志。
- 延迟仍不能默认化：`warm-required P95 / cold P95` 分别为 lishuedu `25.43x`、cipherlink `48.09x`、exam-parent-v3 `63.19x`，均超过 `5x` 阈值。
- lishuedu `warm-auto` 未启用 semantic enrichment，却仍出现 `P95 1604.12ms`，不能作为默认路径。
- 后续若要扩大 warm，应先做 warm latency optimization；本轮不做 Task 3/4/5，也不做 profile-aware warm。

## Method

构建：

```bash
npm run build
```

执行命令：

```bash
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state warm-auto --strategy impact --runs 5 --verbosity diagnostic
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state warm-required --strategy impact --runs 5 --verbosity diagnostic
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state warm-required --strategy impact --runs 5 --verbosity diagnostic
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state warm-required --strategy impact --runs 5 --verbosity diagnostic
```

`semantic.used` 来自 benchmark attribution 的 `goldenAttribution[].semanticUsed`。当前 attempt JSON 未直接暴露 router 内部 `metrics.semantic.timeout`，因此 `semantic.timeout` 以 stderr 中是否出现 `Timed out waiting` / `textDocument/implementation failed` 为观察口径。

## Results

| project | warmState | semantic.used | semantic.timeout log | implementation timeout log | R_read_must | recall | precision | elapsed P50 | elapsed P95 | warm-required / cold P95 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| lishuedu | cold-nolsp | false | false | false | 1.0000 | 0.7756 | 0.4127 | 6.57ms | 66.30ms | 1.00x |
| lishuedu | warm-auto | false | false | false | 1.0000 | 0.7756 | 0.4127 | 1511.20ms | 1604.12ms | N/A |
| lishuedu | warm-required | true | false | false | 1.0000 | 0.8256 | 0.4272 | 7.82ms | 1685.87ms | 25.43x |
| cipherlink | cold-nolsp | false | false | false | 1.0000 | 0.7885 | 0.4230 | 1.97ms | 31.61ms | 1.00x |
| cipherlink | warm-required | true | false | false | 1.0000 | 0.8171 | 0.4316 | 4.21ms | 1519.86ms | 48.09x |
| exam-parent-v3 | cold-nolsp | false | false | false | 1.0000 | 0.5217 | 0.3333 | 1.55ms | 23.82ms | 1.00x |
| exam-parent-v3 | warm-required | true | false | false | 1.0000 | 0.5883 | 0.3473 | 2.27ms | 1505.08ms | 63.19x |

## Observations

- `warm-required` 有 recall 收益：lishuedu `0.7756 -> 0.8256`，cipherlink `0.7885 -> 0.8171`，exam-parent-v3 `0.5217 -> 0.5883`。
- P95 长尾仍接近或超过 1500ms semantic timeout budget，即使 stderr 没有记录 request timeout。
- `warm-auto` 在 lishuedu 上没有 semantic 收益，`semantic.used=false`，但 P50/P95 明显高于 cold，不能默认化。
- 本轮 stderr 文件均为 0B，未观察到 `textDocument/implementation failed` 或 `Timed out waiting for textDocument/implementation`。

## Default Decision

不满足默认化条件：

- `warm-required P95 > cold P95 * 5` 在三个真实项目全部成立。
- 虽然本轮没有 implementation timeout 日志，但 warm-required 尾延迟本身已经足够阻止默认化。
- 在 warm 延迟稳定前，不扩大 `warm-auto` profile，也不启动 profile-aware warm。

下一阶段若继续推进 warm，优先级应是 latency optimization，包括批量 semantic request、implementation/reference 超时治理和 warm session 成本拆分。Task 3/4/5 仍应由扩充后的 attribution 数据另行触发。
