# scripts 索引

`npm run check:hygiene` 要求每个新增脚本（`scripts/*.mjs`、`*.sh`，测试除外）被 package.json、另一个脚本或本文件引用。只由文档或 Mac 手册调用的脚本登记在这里，一行一个，写明用途和入口文档。

| 脚本 | 用途 | 入口 |
|---|---|---|
| `check-repo-hygiene.mjs` | 仓库卫生门禁（基线模式） | `gate:pr`、AGENTS.md |

存量中未被引用的脚本记录在 `repo-hygiene-baseline.json` 的 `unreferencedScripts`，删除或登记后用 `--write-baseline` 收紧。
