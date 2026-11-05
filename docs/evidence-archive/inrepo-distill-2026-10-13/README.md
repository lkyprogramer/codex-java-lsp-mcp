# 仓库内证据提炼记录（2026-10-13）

提交前，`docs/next-stage/*-evidence/` 下共有 19,731 个未跟踪文件。仓库只保留结论和必要证据：

- 保留 110 个文件（约 2.9 MiB）：各阶段的 review、报告、manifest 等结论 Markdown，以及被仓库内 Markdown 直接链接、且不超过 1 MiB 的证据文件。
- 其余 19,621 个文件（193.2 MiB）无损打包为 `inrepo-raw.tar.xz`（29.1 MiB），只保存在本机：`/Users/luo/Documents/evidence-archive/codex-java-lsp-mcp/inrepo-distill-2026-10-13/`。包内保留原仓库相对路径，`manifest.json` 逐文件记录字节数、sha256、移出原因和引用方。打包后已解包并逐个重算 sha256，全部一致后才从仓库删除。
- 另有 1,072 个被 `.gitignore` 隐藏的文件（10.3 MiB，主要是 `*.log`、`dist/` 和 fixture 自带忽略规则下的 Gradle 缓存）同样移入本机的 `inrepo-ignored-leftover.tar.xz`（0.7 MiB，sha256 `95fd17d5783511a53e2e87270c8063c5388256a98178942eee5ffbafa9f056ec`），并补记在同一份 `manifest.json` 中。

| 移出原因 | 文件数 | MiB | 内容 |
| --- | ---: | ---: | --- |
| `copy-or-cache` | 17,078 | 64.7 | 评测 attempt 工作区（公开 fixture 的整份副本）、`source-snapshots/`、编译产物、npm 缓存 |
| `run-detail` | 2,048 | 41.6 | `run/block-*` 下逐 attempt 的评分单、judge 记录、模型请求与响应 |
| `raw-blob` | 13 | 53.6 | git bundle（`a77b6428ca43`、`8f737ac7cd14` 等）、perf probe 的 SQLite 库、原始记录压缩包 |
| `unreferenced-raw` | 482 | 33.2 | 未被任何文档引用的原始 JSON 和日志，其中包括 12.4 MiB 的 `copied-files-inventory.json` |

以下文件被结论文档链接，但属于原始压缩包，也已移入本机归档，原路径不变：

- `docs/next-stage/evidence-protocol-experiment-evidence/p4/model-raw.tar.gz`
- `docs/next-stage/k29-remediation-evidence/raw/live-full-raw.tar.gz`
- `docs/next-stage/runtime-integrity-evidence/raw/08f4ad06f30c8142-live-next-raw.tar.gz`
- `docs/next-stage/runtime-integrity-evidence/raw/1582086eec3f8398-frozen-ignored-logs.tar.gz`

恢复某个文件：

```bash
cd /Users/luo/Documents/evidence-archive/codex-java-lsp-mcp/inrepo-distill-2026-10-13
shasum -a 256 inrepo-raw.tar.xz   # 2b93265b7bb5a297d66d7ea0162f8a8de4aabd7dbb60c12a6c238c96f6906c31
xz -dc inrepo-raw.tar.xz | tar -xf - -C <目标目录> '<原仓库相对路径>'
```
