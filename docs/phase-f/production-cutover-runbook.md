# 本机 Java LSP 生产切流手册

- 日期：2026-08-24
- 机器：lky 本机 macOS（Codex CLI / Desktop 正在用的 HTTP daemon）
- 从：runtime `bc3ca3b13ff5`（2026-08-14，7 工具 + SourceIndex）
- 到：git `main` `2f60a87`（merge `e48a253`，5 工具 + JavaIndex）
- 范围：**只切这台机器上正在服务的 daemon**。不 push、不改远程、不复活 `java_context`。
- 本文件本身会使 git 工作区变脏；**跑 `./install-runtime.sh` 之前必须先处理干净工作区**（见 §3）。

本文是操作真源。旧 canary runbook（`docs/shared-http-daemon-canary-runbook.md`）仍写着 SourceIndex 和 `allSevenTools`，**这次不要照那份做 HTTP 激活**。

---

## 0. 30 秒决策表

| 动作 | 做不做 |
|---|---|
| `./install-runtime.sh`（无 `--activate-http`） | **做。这是真正替换。** |
| 删 7 个已启用仓里的 SourceIndex / schema-2 JavaIndex 快照 | **做。装完立刻删，再预热。** |
| 清空整个 `~/Library/Caches/codex-java-lsp`（约 23 GiB） | **禁止。** 会丢掉 JDT workspace 和 ownership |
| 改 `~/.codex/config.toml` MCP URL | **不改。** 已是 `http://127.0.0.1:38456/mcp` |
| 改 hook 路径 / 手改 `run-hook-gate.sh` | **不改。** 安装器覆盖稳定入口 |
| 改 `~/.config/codex-java-lsp/projects.json` | **不改。** 7 个 alias 全开，schema 未变 |
| 往 LaunchAgent 加 `JAVA_LSP_ENGINE` | **禁止。** |
| `--activate-http` | **禁止。** 已在 HTTP；那条门还要 `allSevenTools=true` |
| 7 仓并行冷建 或 7 仓同时 `start=true` | **禁止。** `BUILD_SLOT=1`，JDT 最多 3 个 |
| Restart Codex，开**新** task | **做。** 工具面 7→5 |
| `git push` | 本机不需要 |

---

## 1. 切换会造成什么

| 影响 | 细节 |
|---|---|
| Codex MCP 短暂不可用 | `install-runtime.sh` 会停旧 daemon、换 `current`、起新进程。旧 task 会出现 `Transport closed`，不能原地复活。 |
| 工具面 breaking | 删除 `java_references` / `java_restart` / `java_shutdown`。改为 `java_symbol(operation=references)`、`java_runtime(action=restart\|shutdown)`。 |
| 索引 | SourceIndex 退役。7 个仓都要重建 JavaIndex v4。磁盘上 7 月的 `java-index-snapshot.json.gz` 是 schema 2，新代码会当成损坏丢掉。 |
| 首次查询变慢 | lishuedu 冷建曾测到 ~83s、child RSS 可到 ~1.8 GiB。本手册用串行预热把这笔成本提前。 |
| JDT | `maxActiveRepos=3`。lishuedu / exam / lishu-v2 的 `workspace/` 可复用，不必删。 |
| Hook | 路径不变。新 `hook-gate.js` 随 `current` 切换。 |
| 不改的 | MCP URL、端口 38456、`projects.json`、JDK、`JDTLS_BIN`、cache 根目录。 |

预计耗时：安装（含隔离测试 + canary）20–45 min；7 仓串行 JavaIndex 预热 15–30 min（lishuedu 占大头）；Codex 重启 + 冒烟 5 min。

---

## 2. 当前生产事实（执行前再核对一遍）

| 项 | 值 |
|---|---|
| 线上 `current` | `~/Library/Application Support/codex-java-lsp-mcp/current` → `releases/bc3ca3b13ff5-20260814T034557Z` |
| `/healthz` | `http://127.0.0.1:38456/healthz`，`buildSha=bc3ca3b13ff5` |
| LaunchAgent | `com.lky.codex-java-lsp-mcp` |
| Codex MCP | `[mcp_servers.codex-java-lsp] url = "http://127.0.0.1:38456/mcp"` |
| Hook | `UserPromptSubmit` → `~/Library/Application Support/codex-java-lsp-mcp/run-hook-gate.sh` |
| 源码 | `/Users/luo/Documents/github/codex-java-lsp-mcp`，`HEAD=2f60a87` |
| 项目表 | `~/.config/codex-java-lsp/projects.json`，**7 个全 `lspEnabled=true`** |

7 个仓：

| id | root | `.java` | repoHash | 装完后 |
|---|---|---:|---|---|
| lishuedu | `/Users/luo/Documents/program/lishu/lishuedu` | 6081 | `6496e5a49fd9` | 必冷建 |
| fat-service | `/Users/luo/Documents/program/lishu/fat-service` | 2624 | `a1d49bbf4d4f` | 必冷建（无 cache） |
| lishu-v2 | `/Users/luo/Documents/program/lishu-v2` | 1896 | `1c6269869bc1` | 必冷建 |
| exam-parent-v3 | `/Users/luo/Documents/program/exam-parent-v3` | 1410 | `fc2fdfc87e0f` | schema-2 快照作废，冷建 |
| cipherlink | `/Users/luo/Documents/program/cipherlink` | 633 | `d0360a4fa29d` | 同上 |
| analysis-develop-analysis | `/Users/luo/Documents/program/lishu/analysis-develop-analysis` | 226 | `6f4ebd77ba3f` | 冷建很快 |
| recognition-master | `/Users/luo/Documents/program/recognition-master` | 56 | `aaaa210fd5ac` | 冷建很快 |

---

## 3. 前置（失败则停，不要装）

在源码仓执行。shell **不得**带 `JAVA_LSP_ISOLATED_VALIDATION=1` 或 `JDTLS_BIN=/usr/bin/false`。

```bash
cd /Users/luo/Documents/github/codex-java-lsp-mcp
git rev-parse --short=12 HEAD    # 期望 2f60a870a8f4 或至少 2f60a87
git status --porcelain=v1 --untracked-files=all
command -v node; command -v npm; command -v jdtls; command -v rsync
curl -sS http://127.0.0.1:38456/healthz
lsof -nP -iTCP:38457 -sTCP:LISTEN || true   # canary 端口应空闲
```

**干净工作区（安装器硬门）。** 当前会挡住安装的是未跟踪目录：

```text
docs/evals/task30-model-comparison-20260802/
```

再加：若本手册已写入 `docs/phase-f/production-cutover-runbook.md` 且未提交，同样会挡住。处理方式二选一：

1. **移走（推荐，不改 git 历史）**

```bash
mkdir -p /tmp/codex-java-lsp-cutover-hold
mv docs/evals/task30-model-comparison-20260802 /tmp/codex-java-lsp-cutover-hold/
# 若本手册尚未提交：
mv docs/phase-f/production-cutover-runbook.md /tmp/codex-java-lsp-cutover-hold/
git status --porcelain=v1 --untracked-files=all   # 必须空
```

2. 提交本手册（**需你明确授权 `git commit`**）。evals 目录按既有禁令不要提交。

另外确认：

```bash
test -x /opt/homebrew/bin/jdtls
echo "JAVA_LSP_ENGINE=${JAVA_LSP_ENGINE-<unset>}"   # 必须空
echo "JDTLS_BIN=${JDTLS_BIN-<unset>}"               # 空，或绝对路径指向真 jdtls
```

---

## 4. 记录回滚基线

```bash
RUNTIME="$HOME/Library/Application Support/codex-java-lsp-mcp"
BASE=/tmp/codex-java-lsp-cutover-baseline-$(date +%Y%m%dT%H%M%S)
mkdir -p "$BASE"
curl -sS http://127.0.0.1:38456/healthz | tee "$BASE/healthz-before.json"
readlink "$RUNTIME/current" | tee "$BASE/current-before.txt"
cp "$RUNTIME/state/daemon.env" "$BASE/daemon.env-before"
plutil -p "$HOME/Library/LaunchAgents/com.lky.codex-java-lsp-mcp.plist" > "$BASE/plist-before.txt"
codex mcp get codex-java-lsp --json | tee "$BASE/mcp-before.json"
echo "rollback-release 的 previous-current: $(readlink "$RUNTIME/state/previous-current")"
```

安装成功后，installer 会把 `previous-current` 指到刚替换掉的 `bc3ca3b…`。回滚命令见 §11。

---

## 5. 安装（真正替换 daemon）

**不要**加 `--activate-http`。**不要**先在源码仓 `npm ci`（会动这份 checkout 的 `node_modules`；安装器在 release 目录里自己 `npm ci`）。

```bash
cd /Users/luo/Documents/github/codex-java-lsp-mcp
unset JAVA_LSP_ISOLATED_VALIDATION JAVA_LSP_ENGINE JDTLS_BIN
export PATH="/Users/luo/.nvm/versions/node/v22.16.0/bin:/opt/homebrew/bin:/usr/bin:/bin"
./install-runtime.sh
```

安装器会：校验干净树 → 复制到 `releases/<12位sha>-<UTC>` → 隔离 `npm ci`+build+测试 → 38457 canary smoke → 原子换 `current` → 重写 LaunchAgent（新 `JAVA_LSP_HTTP_INSTANCE_ID`）→ 重启 38456。

成功判据：

```bash
RUNTIME="$HOME/Library/Application Support/codex-java-lsp-mcp"
"$RUNTIME/daemonctl.sh" status
"$RUNTIME/daemonctl.sh" smoke
curl -sS http://127.0.0.1:38456/healthz
# buildSha 必须是 2f60a870a8f4（或当前 HEAD 的 12 位），不能再是 bc3ca3b13ff5
cat "$RUNTIME/current/dist/build-stamp.json"
readlink "$RUNTIME/current"
```

`daemonctl.sh smoke` 必须列出恰好这 5 个工具：

`java_diagnostics` `java_impact` `java_runtime` `java_status` `java_symbol`

失败：不要手改 plist。用 §11 回滚。看 `~/Library/Logs/codex-java-lsp-mcp/daemon.stderr.log`。

---

## 6. 删除老索引（装完立刻做，装前不要做）

**装前删会打到仍在跑的 `bc3ca3b`（它还靠 SourceIndex）。**

只删索引垃圾，**保留** `workspace/`（JDT）、`logs/`、`repo-meta.json`、`.ownership`。

```bash
CACHE="$HOME/Library/Caches/codex-java-lsp"
# 7 个已启用仓的 repoHash
for h in 6496e5a49fd9 a1d49bbf4d4f 1c6269869bc1 fc2fdfc87e0f d0360a4fa29d 6f4ebd77ba3f aaaa210fd5ac; do
  d="$CACHE/$h"
  [ -d "$d" ] || continue
  rm -f \
    "$d"/source-index.files.jsonl \
    "$d"/source-index.symbols.jsonl \
    "$d"/source-index.meta.json \
    "$d"/semantic-edges.jsonl \
    "$d"/java-index-v2.initialized \
    "$d"/java-index-snapshot.json.gz
  # schema-2 gzip JSON；v4 是 CJV4 魔数。旧文件留着只会在第一次 OPEN 被 discard
done
```

可选（全 cache 清 SourceIndex 残留，不动 JDT workspace；23 GiB 里真正该删的是这些 jsonl，不是整个目录）：

```bash
# 先看体积再删
find "$CACHE" -maxdepth 2 \( \
    -name 'source-index.*' -o \
    -name 'semantic-edges.jsonl' -o \
    -name 'java-index-v2.initialized' \
  \) -type f -print
# 确认后：
find "$CACHE" -maxdepth 2 \( \
    -name 'source-index.*' -o \
    -name 'semantic-edges.jsonl' -o \
    -name 'java-index-v2.initialized' \
  \) -type f -delete
```

schema-2 的 `java-index-snapshot.json.gz` 只在确认是 gzip JSON 时删（新 v4 快照是 `CJV4` 二进制，**不能**按文件名误删预热产物）：

```bash
python3 - <<'PY'
from pathlib import Path
cache = Path.home() / "Library/Caches/codex-java-lsp"
for p in cache.glob("*/java-index-snapshot.json.gz"):
    raw = p.read_bytes()[:4]
    if raw == b"CJV4":
        print("KEEP v4", p)
        continue
    if raw[:2] == b"\x1f\x8b":
        p.unlink()
        print("DEL gzip-json", p)
    else:
        print("SKIP unknown", p, raw)
PY
```

装完含 L0/L1/L2 janitor 的 release 后，优先用同一套规则收割，不要手写 `find` 扫 8000 个目录：

```bash
# 必须先看将删列表：不得出现 7 个 pin 主仓
node scripts/harvest-java-lsp-cache.mjs --dry-run
# 确认后
node scripts/harvest-java-lsp-cache.mjs --apply
```

`projects.json` 里 `lspEnabled` 的 root 不会被 TTL/帽删掉。死路径、无 meta、退役 SourceIndex、以及 MCP 已不再使用的 Codex worktree 会进删除列表。

**禁止：** `rm -rf ~/Library/Caches/codex-java-lsp`、删 `.ownership`、在 daemon 持有该 runtime 时删它的目录（harvest/janitor 会 skip live lease / live JDT）。

---

## 7. 串行预热 JavaIndex（7 个全做，不要并行）

`BUILD_SLOT=1`。并行第二个 child 最多等 180s，抢不到会退回进程内扫，RSS 更差。

**不要加 `--start`。** 这步只建 JavaIndex，不拉 JDT。

```bash
RUNTIME="$HOME/Library/Application Support/codex-java-lsp-mcp"
URL=http://127.0.0.1:38456/mcp
NODE="${NODE_BIN:-$(command -v node)}"
# 大仓在前
IDS=(lishuedu fat-service lishu-v2 exam-parent-v3 cipherlink analysis-develop-analysis recognition-master)

cd "$RUNTIME/current"
for id in "${IDS[@]}"; do
  echo "==== warmup $id $(date +%H:%M:%S) ===="
  "$NODE" dist/smoke-http.js --url "$URL" --project-id "$id" --expect-build "$(
    "$NODE" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("dist/build-stamp.json","utf8")).gitSha)'
  )"
  "$NODE" --input-type=module -e '
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const id = process.argv[1];
const url = process.argv[2];
const deadline = Date.now() + 15 * 60 * 1000;
async function once() {
  const client = new Client({ name: "warmup", version: "0.1.0" });
  const t = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(t);
  try {
    const r = await client.callTool({ name: "java_status", arguments: { projectId: id, start: false } });
    const text = r.content?.map(c => c.text).join("") || "";
    return JSON.parse(text);
  } finally {
    await client.close().catch(() => undefined);
  }
}
let last;
while (Date.now() < deadline) {
  last = await once();
  const idx = last.javaIndex || {};
  console.log(JSON.stringify({ id, coverage: idx.coverage, files: idx.files, pendingBackground: idx.pendingBackground, state: idx.state }));
  if (idx.coverage === "complete" && (idx.pendingBackground ?? 0) === 0 && (idx.files ?? 0) > 0) {
    process.exit(0);
  }
  await new Promise(r => setTimeout(r, 5000));
}
console.error("warmup timeout", id, last?.javaIndex);
process.exit(1);
' "$id" "$URL" || { echo "FAIL warmup $id"; exit 1; }
done
```

完成判据（每个仓）：`javaIndex.coverage=complete`，`pendingBackground=0`，`files>0`。

lishuedu 可能第一次 `java_status` 在 120s 请求预算内返回 `partial`，循环再问即可，后台 child 不会停。

预热完 hibernate 默认 5 分钟会卸内存里的 facts；**磁盘快照留下**。之后第一次真实查询是 hydrate，不是再扫树。

---

## 8. 可选：只给今天要开的仓拉 JDT

最多 2–3 个。7 个全 `start=true` 会顶满 `maxActiveRepos=3`。

```bash
cd "$HOME/Library/Application Support/codex-java-lsp-mcp/current"
# 例：今天要干活的仓
for id in lishuedu lishu-v2; do
  node dist/smoke-http.js --url http://127.0.0.1:38456/mcp --project-id "$id" --start
done
```

`--start` 成功：该仓 `started=true` 且有 `jdtlsPid`。失败不要当成 JavaIndex 失败；查 `JDTLS_BIN`、项目 JDK、daemon.stderr。

---

## 9. Codex 侧切换（配置几乎不用改）

1. **不要改** `~/.codex/config.toml` 里的 URL 和 hook 路径。
2. **Restart Codex CLI 和 Desktop**（工具 schema 7→5，旧 session 会继续调已删除的名字）。
3. **开新 task**，不要复用已经 `Transport closed` 的会话。
4. 在已启用 Java 仓里发一条带「修复/影响面/Service」的 prompt，hook 应注入 `JAVA_LSP_ADVISOR`。

Hook 离线自检（不依赖 Codex）：

```bash
export NODE_BIN="/Users/luo/.nvm/versions/node/v22.16.0/bin/node"
printf '%s' '{"cwd":"/Users/luo/Documents/program/lishu/lishuedu","prompt":"修复 OrderService 影响面"}' \
  | "$HOME/Library/Application Support/codex-java-lsp-mcp/run-hook-gate.sh"
# 期望 JSON 含 JAVA_LSP_ADVISOR 和 java_status / java_impact
printf '%s' '{"cwd":"/tmp","prompt":"hello"}' \
  | "$HOME/Library/Application Support/codex-java-lsp-mcp/run-hook-gate.sh"
# 期望 {"continue":true} 且无 JAVA_LSP_ADVISOR
```

`install-hook.sh` **不必重跑**（只是打印那段 JSON；config 里已经有了）。

---

## 10. 切换完成验证清单

全部做完再宣布上线。

```bash
RUNTIME="$HOME/Library/Application Support/codex-java-lsp-mcp"
NODE="${NODE_BIN:-$(command -v node)}"

# A. daemon 身份
curl -sS http://127.0.0.1:38456/healthz
curl -sS http://127.0.0.1:38456/readyz
"$RUNTIME/daemonctl.sh" status
"$RUNTIME/daemonctl.sh" smoke
# healthz.buildSha == current/dist/build-stamp.json.gitSha == 2f60a870a8f4…
# tools 恰好 5 个，无 java_context / java_references / java_restart / java_shutdown

# B. Codex 注册未漂
codex mcp get codex-java-lsp --json
# transport.type=streamable_http, url=http://127.0.0.1:38456/mcp

./check-codex-mcp.sh --fast
./check-codex-mcp.sh --smoke --alias lishuedu

# C. 索引已是 v4（预热过的仓应有 CJV4 快照，不再有 source-index.*）
python3 - <<'PY'
from pathlib import Path
cache = Path.home() / "Library/Caches/codex-java-lsp"
hashes = {
  "lishuedu": "6496e5a49fd9",
  "fat-service": "a1d49bbf4d4f",
  "lishu-v2": "1c6269869bc1",
  "exam-parent-v3": "fc2fdfc87e0f",
  "cipherlink": "d0360a4fa29d",
  "analysis-develop-analysis": "6f4ebd77ba3f",
  "recognition-master": "aaaa210fd5ac",
}
for name, h in hashes.items():
    d = cache / h
    snap = d / "java-index-snapshot.json.gz"
    stale = list(d.glob("source-index.*")) if d.exists() else []
    magic = snap.read_bytes()[:4] if snap.exists() else None
    print(f"{name:28} snap={magic} stale={len(stale)}")
PY

# D. 真实调用（新 Codex task 或 MCP）
# java_status({projectId:"lishuedu", start:false})
#   repoRoot 必须等于 /Users/luo/Documents/program/lishu/lishuedu
#   javaIndex.coverage=complete
# java_impact 一条真实锚点，应返回 readPlan，不得报旧工具名
# 不要调 java_references / java_restart / java_shutdown
```

生产默认抽查（应已满足，发现不对就回滚，不要现场改环境变量凑）：

- 公开工具 5 个，无 `java_context`
- plist 无 `JAVA_LSP_ENGINE`
- `JAVA_LSP_COLD_BUILD_CHILD` 未设（默认开）
- `HIBERNATE` 走代码默认 300000，`BUILD_SLOT=1`

---

## 11. 回滚

**只回 runtime，不要先 `git reset`。** 线上进程读的是 Application Support，不是这份 git checkout。

```bash
# 1) 把 daemon 退回安装器记下的上一 release（应是 bc3ca3b…）
"$HOME/Library/Application Support/codex-java-lsp-mcp/daemonctl.sh" rollback-release
"$HOME/Library/Application Support/codex-java-lsp-mcp/daemonctl.sh" status
curl -sS http://127.0.0.1:38456/healthz   # 期望 buildSha 回到 bc3ca3b13ff5

# 2) Restart Codex，开新 task（工具面变回 7 个）
```

`rollback-stdio` **不要用**——当前本来就不是 stdio。

git 回滚（仅当还要撤回仓库 merge，且未 push）：

```bash
# 未分享 e48a253 时才允许；会丢掉 F2 文档提交
# git reset --hard 48e665b
# 已分享则：
# git revert -m 1 e48a253
```

回滚后 SourceIndex 已被 §6 删掉，旧 daemon 会自己重建 SourceIndex。这是可接受代价。若必须立刻恢复旧速度，只能从 Time Machine / 备份恢复 cache；本手册不保留 SourceIndex 备份。

---

## 12. Soak（装完才算 F3）

观察 24–48h，见 `docs/phase-f/f3-soak.md`。

- 2–3 个真实项目并行 + 至少一个 git worktree
- RSS、hibernate 5 min 后堆是否下来、冷建是否仍只有 1 个 child
- 再跑一次 `npm run gate:nightly`（隔离，不指向生产 cache）
- 正确性回归（crash、coverage 漂、工具面变了）→ §11

未满 24h 不要把 8/24 计划标 COMPLETE。

---

## 13. 注意事项（容易踩）

1. 安装器拒绝脏树。手册和 evals 要么移走要么提交。
2. 装的时候 38456 会断。提前结束正在跑的 Java Codex task。
3. 旧 task 的 7 工具 schema 是废的。必须新 task。
4. 不要 `--activate-http`，不要改 hook 去指向 git 工作区 `dist/`。
5. 不要 7 仓并行预热，不要 7 仓同时 JDT。
6. 不要设 `JAVA_LSP_ENGINE`、`JAVA_LSP_COLD_BUILD_CHILD=0`、`JDTLS_BIN=/usr/bin/false`。
7. `java_status` 不带 `projectId`/`repoRoot` 只返回 daemon 摘要，**不会**建索引。
8. 全 cache 23 GiB 主要是历史 worktree，不是这 7 个仓的 SourceIndex。禁止整目录删除。
9. 本机 push 不是上线条件。别的机器要各自跑这份安装，不要 scp `current`。
10. cipherlink holdout 0.55、O1/O2 残差带病上线，不在这次修。

---

## 14. 配置对照（默认保持，不要为切流改）

| 配置 | 路径 / 变量 | 切流 |
|---|---|---|
| MCP | `~/.codex/config.toml` `[mcp_servers.codex-java-lsp]` | 不动 |
| Hook | 同文件 `UserPromptSubmit` | 不动 |
| 项目 | `~/.config/codex-java-lsp/projects.json` | 不动 |
| Runtime | `~/Library/Application Support/codex-java-lsp-mcp` | 安装器改 `current` / plist / 稳定脚本 |
| Cache | `~/Library/Caches/codex-java-lsp` | 只删 §6 列出的老索引文件 |
| 日志 | `~/Library/Logs/codex-java-lsp-mcp` | 不动 |
| 端口 | `JAVA_LSP_HTTP_PORT=38456` | 不动 |
| JDT | `/opt/homebrew/bin/jdtls`，Xmx 默认 `2g` | 不动 |
| TTL | idle 2700000，hibernate 300000 | 不写进 plist |
| 并发 | `MAX_ACTIVE_REPOS=3`，`BUILD_SLOT=1` | 不改 |

工具对照：

| 旧（线上） | 新 |
|---|---|
| `java_status` | 同名 |
| `java_impact` | 同名（紧凑输出，token −27%） |
| `java_symbol` | 同名；`operation=query\|position\|references` |
| `java_references` | **删除** → `java_symbol` `operation=references` |
| `java_diagnostics` | 同名 |
| `java_restart` | **删除** → `java_runtime` `action=restart` |
| `java_shutdown` | **删除** → `java_runtime` `action=shutdown` |
| （无） | `java_context` **不要出现** |

---

## 15. 推荐执行顺序（一份清单）

1. §3 前置；移走脏文件；确认 38457 空闲、`JAVA_LSP_ENGINE` 未设。
2. §4 基线快照。
3. 通知自己：接下来 38456 会断，关掉进行中的 Java Codex task。
4. §5 `./install-runtime.sh`（无 `--activate-http`）。
5. 确认 `/healthz` SHA 已换。
6. §6 删 7 仓老索引（可选全 cache 的 `source-index.*`）。
7. §7 按表串行预热 7 仓 JavaIndex，直到 `coverage=complete`。
8. §8 可选：今天要开的 2 仓 `--start`。
9. §9 Restart Codex，新 task，hook 自检。
10. §10 验证清单全绿。
11. §12 soak 24–48h。出问题 §11 回滚。
