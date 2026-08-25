# Daemon 稳定性与内存治理方案（W/S/M 三轨 + V 验收）

- 状态：ADOPTED（R0，2026-08-25）
- 范围：HTTP daemon 的事件循环冻结、超时死亡螺旋、内存账本三类生产问题的彻底解决
- 输入证据：本仓代码核实（本文所有行号均已人工确认）、grok 排查报告（`/Users/luo/Documents/grok/lsp1.md`、`lsp2.md`）、2026-08-25 上午的现场诊断（进程采样、遥测 JSONL、daemon 日志）
- 生效 pin：`lishuedu`、`exam-parent-v3`、`cipherlink`、`lishu-v2`（4 个 lspEnabled，来源 `~/.config/codex-java-lsp/projects.json`，已核实）
- 分支基线：`codex/frontier-r1` @ `2020ee7`（W1 的三处修复已在工作区暂存，见 §4.W1）

---

## 0. 执行者必读

### 0.1 三类问题的一句话画像

| 问题 | 现场表现 | 根因（已核实） | 归属轨道 |
| --- | --- | --- | --- |
| P1 事件循环冻结 | healthz 都超时、僵尸子进程、主线程 system time 是 user time 的 3 倍 | watcher `ignored` 谓词每事件做同步 realpath 风暴；JDK 探测同步 spawnSync ×7×2s | W 轨（已改完，待提交部署） |
| P2 超时死亡螺旋 | `Deadline exceeded before java-index.query_read_ranges`；一次超时后 worker 重启、下次再付 120s OPEN | QUERY 超时无条件 retire worker；预热在 files-only DURABLE 就宣布就绪；read-plan 对超时 fail-hard | S 轨 |
| P3 内存账本失衡 | Activity Monitor 4–5 GiB 峰值、1.9 GiB 常驻 footprint | pin 仓 worker isolate 常驻不关；hibernate 只卸 facts 不还 isolate；冷建 child 3 GiB 峰值叠加；worktree 缓存 3 倍复制 | M 轨 |

### 0.2 硬禁令（每张卡适用）

1. **不动 G4 的 STATUS 廉价路径**：OPEN 保持 files-only，不在 OPEN/verify 的 finally 里自动 kick hydrate（会把 java_status 堵在 rest decode 上）。
2. **不加新 worker RPC 类型**：S2 的预热 hydrate 复用现有 `QUERY_REPOSITORY_FACT_MARKERS`（空 prefix 即可触发 `ensureFactsHydrated`，worker 2030 行已核实）。
3. **OPEN 超时仍然 retire worker**：现有测试 `a silent OPEN deadline terminates the worker` 是正确契约，保留。
4. **不削弱非超时错误**：`INDEX_PARTIAL` / `INDEX_CORRUPT` / `OUTSIDE_REPO` 照旧上抛，fail-soft 只覆盖 `DEADLINE_EXCEEDED`。
5. **不改 v4 golden、不动 read-plan 正常路径的选择逻辑**：S3 只在 budget 已耗尽的退化分支上加行为。
6. **生产安装（`./install-runtime.sh`）只允许出现在任务卡的「部署」步骤里**，且安装前必须全量测试绿、安装后必须跑该卡的现场验证探针；`daemonctl.sh rollback-release` 是每次安装的逃生通道，装前先确认它可用（`daemonctl.sh status` 能看到 previous-current 指针）。
7. **本机 git 陷阱**：默认 PATH 上的 git 不支持 `init -b` / `--trailer`，跑测试与提交一律加 `PATH="/opt/homebrew/bin:$PATH"` 前缀（homebrew git 2.52 已确认可用）。
8. 三仓矩阵政策照旧：本方案只有 V1 的 identity 快检需要跑仓级测试；1 分钟 load < 20 时不得以主机不安静为由跳过（见 `docs/phase-v4/three-repo-host-load-policy.md`）。

### 0.3 决策默认值（避免执行中停下来问人）

| 决策点 | 默认值 | 依据 |
| --- | --- | --- |
| 预热热集（M1） | `lishuedu,lishu-v2`（env `JAVA_LSP_PREWARM_HOT` 可覆盖，逗号分隔 alias） | 用户日常主力仓；4 仓全 hydrate 会让稳态 heap 超 1 GiB |
| JavaIndex worker 空闲关闭 TTL（M2） | 20 分钟（env `JAVA_LSP_INDEX_IDLE_TTL_MS`，0 = 关闭该行为） | hibernate（5 分钟）之后再给一段热窗口，之后 isolate 应还给 OS |
| daemon 主进程 heap 上限（M3） | `--max-old-space-size=768` | 主进程自身逻辑很小；isolate 内存由各 worker 自己的 1536 上限管 |
| S1 保留 retire 的 RPC 集合 | `OPEN`、`REFRESH`、`REFRESH_RESOURCES`、`RECONCILE`、`FLUSH`、`HIBERNATE`、`CLOSE` | 这些是可能真 wedged 的变异/长任务；`QUERY_*` 与 `STATUS` 只 reject 不 terminate |
| 卡内三振 | 同一张卡连续 3 次验证失败 → 停下写 `docs/phase-d/dX-escalation.md`，不带病推进 | 沿用 JIN 纪律 |

### 0.4 已核实的代码锚点速查（写代码前先读这些）

| 锚点 | 内容 |
| --- | --- |
| `src/java-index/java-index-client.ts:652-661` | `budget.race` 超时回调：`rejectPending` 后无条件 `retireWorker(..., "DEADLINE_EXCEEDED")` —— S1 的手术点 |
| `src/java-index/java-index-client.ts:107-114` | `isJavaIndexPrewarmReady`：`snapshot.state === "DURABLE"` 直接 true，不看 facts —— S2 的手术点 |
| `src/java-index/java-index-client.ts:138-139` | worker 重启 OPEN 预算 120s —— 死亡螺旋的代价来源 |
| `src/java-index/java-index-worker.ts:1188/2030/2154/2196` | `ensureFactsHydrated`：第一次 fact 查询同步整包解码 rest 段（lishuedu ~27MB gz） |
| `src/java-index/java-index-worker.ts:1240-1252` | `hibernateIndex`：dirty 则先 hydrate+flush，然后 `cache?.clear()` —— 只卸 facts，isolate 不还 |
| `src/agent-router/read-plan.ts:125-141` | `buildReadPlan` 直接 `await queryReadRanges`，无 try/catch —— S3 的手术点 |
| `src/repo-runtime-manager.ts:239-260` | `prewarmRepo`：`awaitPrewarmReady` → 未就绪则 `reconcile` → 非 DURABLE 则 `flush` |
| `src/repo-runtime-manager.ts:1006-1025` | `scheduleIdleShutdown`：idleTimer 只在 `lspReservation !== "NONE"` 时 `stopEntry` —— **纯 JavaIndex runtime 永不关闭**，M2 的手术点 |
| `src/repo-runtime-manager.ts:1061-1075` | `hibernateEntry` 只调 client.hibernate；`stopEntry` 只停 JDT 会话 |
| `src/repo-runtime-manager.ts:588-606, 626-630` | 完整关闭（coordinator.close + javaIndexClient.close）只发生在超限驱逐/关停路径 |
| `src/application.ts:99-106, 237-258` | `startPinnedRepoPrewarm` → 串行 `prewarmRepo` 全部 lspEnabled alias —— M1 的手术点 |
| `src/java-index/cold-build-child.ts:38` | 冷建 child `--max-old-space-size=1536`；lishuedu 实测 rssPeak 2.87G（native tree-sitter 不受 V8 上限约束） |
| `run-daemon.sh`（运行时目录） | daemon 主进程无任何 NODE_OPTIONS/heap 上限 —— M3 的手术点 |
| `src/repo-change-coordinator.ts` / `src/project-jdk.ts` / `src/java-index/cold-build-child.ts` | W1 的三处修复已在工作区完成并通过全量测试（1239+278 全绿） |

### 0.5 已核实的数字基线（2026-08-25 现场）

单仓冷建/快照账本（`~/Library/Caches/codex-java-lsp/*/cold-build-metrics.json`）：

| 仓（repoHash） | files | 快照 gz | 冷建 child rssPeak | 冷建 heap |
| --- | --- | --- | --- | --- |
| lishuedu (6496e5a4) | 6081 | 27.0M | 2.87G | 641M |
| cipherlink (a1d49bbf) | 2624 | 15.4M | 2.04G | 439M |
| lishu-v2 主仓 (1c626986) | 1886 | 16.4M | 2.07G | 480M |
| lishu-v2 worktree ×2 (a72d9f68 / abe4393f) | 1886×2 | 16.4M×2 | 1.56G / 1.73G | 480M×2 |
| exam-parent-v3 (fc2fdfc8) | 1409 | 5.9M | 0.82G | 280M |

要点：**lishu-v2 的 2 个 worktree 各自付了一份完整冷建与快照**（3 份内容一致）。根因已实锤（详见 M4 卡内诊断）：主仓一个未提交的 `.sdkmanrc` 使 `buildFingerprint` 永不相等，sibling seed 被指纹精确门一票否决。M-track 已知单仓 hydrate 后 heap：lishuedu ~273 MiB（G1 实测）。首次 hydrate 延迟 ~7.7s（G5 实测），hydrate 后查询 38–76ms。

---

## 1. 问题模型：三条故障链怎么叠成「基本无法工作」

```
链 1（P1，任意时刻）：
  pin 仓在跑 gradle/maven 构建
  → build/ 目录事件洪流 → chokidar ignored 谓词每事件同步 realpath ×(4+4G) 次
  → 主线程 system-call 风暴（实测 94% CPU、healthz 冻结、子进程僵尸）
  ⤷ f3b1214 的 prewarm 让 daemon 一启动就给全部 pin 建 watcher，引爆概率 ×4

链 2（P2，每次 daemon 重启后、每个仓第一次 java_impact）：
  OPEN 恢复 files-only（G4 设计）→ facts 不在内存
  → 第一次 fact 查询同步 ensureFactsHydrated（大仓 ~8s）
  → java_impact 后半段才打 QUERY_READ_RANGES，budget 已被 hydrate 吃光
  → "before query_read_ranges" 整工具失败
  → 若走到 during 超时：retireWorker → 下一请求付 120s 重启 OPEN → 螺旋

链 3（P3，长期）：
  4 pin × worker isolate 常驻一个 PID（idle TTL 只停 JDT，从不关 JavaIndex worker）
  + hibernate 只 cache.clear()，V8 isolate/malloc arena 不还 OS
  + 冷建 child native 峰值 2-3G 与父进程叠加
  + worktree 缓存复制 ×3
  → phys_footprint 常驻 1.9G、峰值 4-5G
```

三条链的修复相互独立、可以分卡落地，但**验收（V1）必须在三轨全部落地后做一次端到端**，因为用户体感是三链叠加的结果。

---

## 2. 数字门（全部以生产形态度量，不再用单仓实验室口径）

| 门 | 定义 | 目标 | 度量方法 |
| --- | --- | --- | --- |
| D1 稳态足迹 | daemon 启动 + 预热完成 + 静置 30 分钟后的 phys_footprint | ≤ 900 MiB（追求 ≤ 700） | `footprint -p <pid>` 或 `vmmap --summary <pid> \| rg "Physical footprint"` |
| D2 风暴免疫 | 任一 pin 仓跑 `gradlew check` 期间，healthz 每秒探测 120 次的最大延迟 | P99 < 100ms，无一次超时 | V1 的 storm 探针脚本 |
| D3a 热 pin 首查 | 预热热集内的仓，daemon ready 后第一次 `java_impact` 延迟 | P95 ≤ 3s，成功率 100% | V1 探针 |
| D3b 冷 pin 首查 | 热集外的仓，第一次 `java_impact` | 不报错（可带 evidence gap 的 file-only plan），worker terminations=0 | V1 探针 + 遥测 JSONL |
| D4 超时不螺旋 | 人为注入短 deadline 的 QUERY 超时后 | worker 不重启；下一请求 ≤ 500ms | S1 单测 + V1 探针 |
| D5 冷建峰值 | 触发一个大仓冷建期间的 daemon+child 合计 footprint；完成后 10 分钟内回落 | 峰值 ≤ 4 GiB；回落到 ≤ D1 | V1 探针 |
| D6 JDK 探测 | daemon 冷启动后首个 `java_status`（新仓）延迟 | ≤ 3s（原 14.8s） | W1 现场验证 |

---

## 3. 执行合同（每张卡适用）

- 分支：全部在 `codex/frontier-r1` 上按卡提交，commit 前缀 `fix(daemon):` / `feat(runtime):` / `test(...)：`，一卡一提交。
- 构建与测试命令（注意 git PATH 前缀）：
  - 编译：`npm run build`
  - 定向测试：`PATH="/opt/homebrew/bin:$PATH" node --test dist/<涉及的>.test.js`
  - 全量 T0：`PATH="/opt/homebrew/bin:$PATH" npm test`（隔离 profile full，约 2 分钟）
  - PR 门：`PATH="/opt/homebrew/bin:$PATH" npm run gate:pr`
- 部署：`./install-runtime.sh`（构建不可变 release + 重启 launchd daemon + smoke）。部署后必跑该卡「现场验证」小节。回滚：`"$RUNTIME_DIR/daemonctl.sh" rollback-release`。
- closeout：每卡完成后写 `docs/phase-d/<卡号>-closeout.json`，schema：

```json
{
  "card": "S1",
  "commit": "<sha>",
  "tests": { "targeted": "PASS", "full": "PASS", "gatePr": "PASS|SKIPPED" },
  "deployed": true,
  "liveProbe": { "name": "...", "result": "PASS", "numbers": {} },
  "gates": { "D4": "PASS" },
  "residual": ["..."]
}
```

- 失败处理：卡内三振 → 写 `docs/phase-d/<卡号>-escalation.md`（现象、已试过什么、下一步两个选项），停止该卡，继续可并行的其他卡。
- 遥测复核：每卡部署后 24h 内看一眼 `~/Library/Caches/codex-java-lsp/telemetry/impact-*.jsonl` 的 `elapsedMs`/`error` 分布，异常写入 residual。

---

## 4. 任务卡

### W1 — 提交并部署事件循环三修复（代码已完成，收尾即可）

- **目标**：把已通过全量测试的三处修复（watcher 谓词零系统调用化、JDK release 文件探测、cold-build child EPIPE 防护）提交、部署、现场验证。
- **现状**：三个文件已暂存于工作区（`git status` 可见 M）：`src/repo-change-coordinator.ts`、`src/project-jdk.ts`、`src/java-index/cold-build-child.ts`。全量测试 1239+278 已全绿。上次 `git commit` 因旧版 git 的 `--trailer` 报错未落库。
- **步骤**：
  1. `PATH="/opt/homebrew/bin:$PATH" git commit -m "fix(daemon): keep watcher ignore and JDK discovery off the event-loop syscall path"`
  2. `PATH="/opt/homebrew/bin:$PATH" npm run gate:pr`（绿才继续）
  3. `./install-runtime.sh`，然后 `"$HOME/Library/Application Support/codex-java-lsp-mcp/daemonctl.sh" wait-ready`
- **现场验证（必须全过）**：
  1. 风暴探针：在 `lishu-v2` 任一 worktree 里起 `./gradlew classes --no-daemon`（或任何会写 build/ 的任务），同时循环 `curl -m 2 http://127.0.0.1:38456/healthz` 60 次——**0 次超时**；`ps -M <daemonPid>` 主线程 system time 增量 < 5s。
  2. D6：`java_status` 打一个从未注册的 Java 仓（如 torna worktree），首次 ≤ 3s（原 14.8s 超时）。
  3. 僵尸检查：`ps -axo ppid,stat | awk '$1==<pid> && $2 ~ /Z/'` 为空。
- **出口**：closeout 写入 D2（初测）、D6 数字。
- **失败处理**：若风暴探针仍冻结 → `sample <pid> 3` 复查主线程栈；若仍是 realpath，检查是否有第二个 `ignored`/`classify` 之外的每事件 syscall 调用点（用本卡同款采样法定位），修复后重走本卡；三振 → 回滚 release 并升级。

### S1 — QUERY/STATUS 超时不再 retire worker

- **目标**：偶发查询超时只让当前调用失败，worker 与其正在做的 hydrate 继续活着；消灭「一次超时 → 120s 重启 OPEN」螺旋。
- **改动锚点**：`src/java-index/java-index-client.ts:652-661` 的 `budget.race` 超时回调。
- **设计**：
  - 引入 `const RETIRE_ON_DEADLINE = new Set(["OPEN","REFRESH","REFRESH_RESOURCES","RECONCILE","FLUSH","HIBERNATE","CLOSE"])`（放在 client 顶部常量区）。
  - 超时回调改为：`rejectPending(...)` 后仅当 `RETIRE_ON_DEADLINE.has(request.type)` 才 `retireWorker`。
  - 迟到的 response 处理已有 tombstone 机制（`cancelledTombstones`），QUERY 超时后把该 id 记入 tombstone（复用 cancel 的路径，不新增状态机），保证不 double-settle。
  - 遥测：`JavaIndexRpcOutcome` 仍记 `deadlineExceeded`；`retireReasons.DEADLINE_EXCEEDED` 只在真 retire 时出现。
- **边界**：不加通用 watchdog；真死循环仍靠 daemon 重启兜底（可接受残余风险，写进 closeout residual）。
- **必改的旧契约测试**（`src/java-index/java-index-client.test.ts`，grep `terminates the worker` / `deadline telemetry`）：
  - `a silent query deadline ... terminates the worker` → 改为断言 `terminations === 0`、state 保持 READY、下一请求复用同一 worker 且成功。
  - `deadline telemetry distinguishes...` → QUERY 记 `deadlineExceeded=1`、无 `retireReasons.DEADLINE_EXCEEDED`、并发 STATUS 能完成。
  - `router-java-index.test.ts` 里 silent query / routerStatus deadline 同步改 `terminations===0`。
  - **保留**：`a silent OPEN deadline terminates the worker` 原样通过。
- **新增测试**：QUERY 超时后同一 worker 再发一个 QUERY 能正常返回；迟到 response 被 tombstone 吞掉不污染后续请求。
- **验证**：定向 `node --test dist/java-index/java-index-client.test.js dist/agent-router/router-java-index.test.js` → 全量 T0 → gate:pr。
- **出口**：D4 单测口径 PASS；与 S2/S3 一起部署（见 S3 出口）。

### S2 — 预热等到 factsHydrated，首查不再替预热买单

- **目标**：pin 仓的 facts hydrate 成本由预热的 300s 预算支付，用户第一次 `java_impact` 直接命中热 facts。
- **改动锚点**：
  1. `src/java-index/worker-protocol.ts`：`JavaIndexStatus` 增加可选字段 `factsHydrated?: boolean`；`validateJavaIndexStatus` round-trip 它（缺省不报错——旧 worker/旧 fixture 兼容）。
  2. `src/java-index/java-index-worker.ts` `currentStatus()`：始终发布 `factsHydrated: snapshotFactsHydrated && !hibernated`（worker 内已有这两个状态变量，grep `factsHydrateInFlight`/`hibernated` 定位）。同时把 `factsHydrateInFlight` 计入 `pendingBackground`（防 STATUS 假 idle）。
  3. `src/java-index/java-index-client.ts:107-114` `isJavaIndexPrewarmReady`：`factsHydrated === false || status.hibernated` → 未就绪；`undefined` 保持旧语义（不阻塞）。
  4. `awaitPrewarmReady()`（client ~249 行的轮询循环）：当 files/snapshot 已就绪但 `factsHydrated === false` 时，发一次 `QUERY_REPOSITORY_FACT_MARKERS`（`importPrefixes: [], annotationPrefixes: []`）触发 `ensureFactsHydrated`（worker 2030 行既有行为），然后继续 poll STATUS。**注意 S2 依赖 S1 先落地**：hydrate 期间 STATUS 轮询超时不能杀 worker。
- **边界**：
  - 不在 OPEN/verify 的 finally 里自动 hydrate（硬禁令 1）。
  - 本卡只加机制，不改「哪些仓 hydrate」的策略——策略在 M1（热集参数）。在 M1 落地前，`prewarmRepo` 对所有 pin 生效 hydrate 属于**过渡状态**，可接受（4 仓 hydrate 稳态 heap 约 1.1–1.2 GiB，M1 会压回来）。
- **新增测试**：
  - `isJavaIndexPrewarmReady`：DURABLE + `factsHydrated:false` → false；字段缺省 → true（兼容）。
  - `awaitPrewarmReady`：files-only DURABLE 后自动发 fact-markers，最终等到 `factsHydrated:true`。
  - `validateJavaIndexStatus` round-trip。
- **验证**：定向（client/worker-protocol/repo-runtime-manager）→ 全量 T0。
- **出口**：与 S1/S3 合并部署；现场验证在 S3 卡。

### S3 — buildReadPlan 对 DEADLINE_EXCEEDED fail-soft

- **目标**：即便 budget 在 read-range 之前被吃光，`java_impact` 仍返回带 evidence gap 的 file-only compact plan，而不是整工具失败。
- **改动锚点**：`src/agent-router/read-plan.ts:136-141` 的 `queryReadRanges` 调用。
- **设计**：
  ```ts
  let rangeResults: ReadRangeResult[] = [];
  if (shortlist.files.length > 0) {
    try {
      rangeResults = await input.javaIndex.queryReadRanges(...);
    } catch (error) {
      if (!(error instanceof JavaIntelligenceError) || error.code !== "DEADLINE_EXCEEDED") throw error;
      deadlineGap = "Read-range query exceeded the request deadline; returning a file-only plan.";
    }
  }
  ```
  空 `rangeResults` 走现有 `materializeWindows` 路径（anchor 仍在、ranges 为空——该路径已有语义，核实 `materializeWindows` 对空结果的行为后再动手）；`deadlineGap` 追加进 `result.evidenceGaps`。
  - router 侧 `ensureOpened` 的 before 超时同样会以 `DEADLINE_EXCEEDED` 抛进这条链——确认它到达 read-plan 的形态（同 code），一并覆盖。
- **边界**：其它错误照旧上抛；既有语义超时测试 `live semantic timeouts share one bounded stage budget...` 必须原样通过（正常路径仍应在 deadline 内完成 range batch，fail-soft 只兜底退化）。
- **新增测试**：mock `queryReadRanges` 抛 `DEADLINE_EXCEEDED` → 返回 plan、`evidenceGaps` 含超时说明、`isError` 为 false；抛 `INDEX_CORRUPT` → 依旧 reject。
- **验证**：定向（read-plan）→ 全量 T0 → gate:pr。
- **S 轨合并部署与现场验证**（S1+S2+S3 一次 install）：
  1. `./install-runtime.sh` → wait-ready。
  2. 重启后立即（预热尚未完成时）对 `lishuedu` 打一次 `java_impact`（deadlineMs 默认）：要么成功、要么返回带 gap 的 plan，**绝不允许** `Deadline exceeded before java-index.query_read_ranges` 式整调用失败；遥测确认 `error:false`。
  3. 等预热完成（日志或 STATUS `factsHydrated:true`）后再打一次：P95 ≤ 3s（D3a 初测）。
  4. 注入检查 D4：`java_impact` 带 `deadlineMs: 1500` 打一个冷仓，超时后立刻再打一次正常请求 ≤ 500ms，且 stderr 无 worker 重启日志。
- **出口**：closeout 记 D3a/D3b/D4 现场数字。

### M1 — 预热分层：热集 hydrate，冷集 files-only + 立即 hibernate

- **目标**：稳态内存由「4 仓全热」压到「2 热 + 2 冷」；冷仓第一次查询靠 S 轨兜底不报错。
- **改动锚点**：`src/application.ts:237-258`（`prewarmPinnedRepos` 循环）、`src/repo-runtime-manager.ts:239-260`（`prewarmRepo` 增加 `hydrate?: boolean` 选项）。
- **设计**：
  - 热集解析：`JAVA_LSP_PREWARM_HOT`（逗号分隔 alias），缺省 `lishuedu,lishu-v2`。非法 alias 忽略并 console.error 一行。
  - 循环内：热集仓 `prewarmRepo({projectId, hydrate:true})`（走 S2 的 factsHydrated 等待）；冷集仓 `prewarmRepo({projectId, hydrate:false})`——只等 files-only DURABLE，然后**立即调用既有 `hibernateEntry` 语义**（通过 manager 暴露的显式 `hibernateRepo(selector)` 或直接让 prewarmRepo 在 `hydrate:false` 时收尾 hibernate，选后者，少一个公共方法）。
  - `isJavaIndexPrewarmReady` 的 hydrate 判定通过参数传递（`hydrate:false` 时不要求 factsHydrated）。
- **边界**：不改 registry 格式；不做「最近使用」自动学习（残余项，记 closeout）。
- **测试**：repo-runtime-manager 单测：hydrate:true 等到 factsHydrated；hydrate:false 在 files-only DURABLE 即返回且 entry.hibernated=true。application 单测：热集解析、缺省值、非法 alias。
- **验证**：定向 → 全量 T0 → 部署 → 现场：重启后 `footprint -p <pid>` 曲线，预热完成 5 分钟后 ≤ 1.2 GiB（M2 落地前的中间门），热集两仓首查 ≤ 3s，冷集两仓首查不报错。
- **出口**：closeout 记 footprint 数字与四仓首查延迟。

### M2 — 空闲关闭 JavaIndex worker（isolate 还给 OS）

- **目标**：冷仓/久未使用仓的 worker isolate 在空闲期整体释放，消灭「1.9 GiB 常驻、RSS 已换出但页面不还」形态。
- **改动锚点**：`src/repo-runtime-manager.ts:1006-1025`（`scheduleIdleShutdown`）与 588-630 的完整关闭路径。
- **设计**：
  - 新增 options：`indexIdleTtlMs`（env `JAVA_LSP_INDEX_IDLE_TTL_MS`，默认 1_200_000 = 20 分钟，0 关闭）。
  - `scheduleIdleShutdown` 增加第三个 timer：`refCount===0 && entry.hibernated` 且到期 → 执行与超限驱逐相同的完整关闭（`coordinator.close()` + `javaIndexClient.close()` + 从 runtimes 池移除该 entry）。复用既有关闭代码（588-606 一带），不要写第二份关闭逻辑。
  - 语义后果（接受并写进注释）：watcher 关闭 → 下次访问走完整 `getOrCreate`（W1 后 runtime.create 已廉价）+ OPEN files-only（1–2s）+ 快照 identity/reconcile 兜底新鲜度——这正是「被驱逐 runtime」的既有语义，无新状态机。
  - **热集仓豁免**：`JAVA_LSP_PREWARM_HOT` 里的 alias 不设第三 timer（它们是用户点名要常驻的）。
- **测试**：fake timer 单测：冷仓 hibernate 后到期 → client.close 被调、entry 移除；热集仓不关；`refCount>0` 时不关；TTL=0 不注册 timer。
- **验证**：定向 → 全量 T0 → 部署 → 现场：预热完成后静置 25 分钟，`footprint -p` 应回落（冷仓 isolate 归还），目标 D1 ≤ 900 MiB；随后访问一个已关闭的冷仓，首查不报错（S 轨兜底）且 ≤ 15s 内完成。
- **失败处理**：若 footprint 不降 → `vmmap --summary` 对比关闭前后 MALLOC 区段；若 isolate 已关但 malloc arena 不还，落 M3 的 daemon 重启兜底讨论进 escalation，不硬撑。

### M3 — daemon 主进程 heap 上限与冷建预算复核

- **目标**：给 daemon 主进程一个明确的 V8 上限，防止未来回归悄悄吃满；复核冷建 child 的并发与峰值。
- **改动锚点**：
  1. 运行时目录 `run-daemon.sh` 的 `exec "$NODE_BIN" ...` 行（源头在仓库里生成该脚本的安装模板，grep `run-daemon.sh` 的生成处，改模板不改现场文件）：加 `--max-old-space-size=768`。
  2. 冷建并发：确认 `2020ee7` 的串行化覆盖「预热触发的重建」与「用户请求触发的冷建」两条路径共用同一把跨进程 build lease（`~/Library/Caches/codex-java-lsp/leases/`）；若用户路径未上锁，补上（复用 lease 机制，不新造）。
- **边界**：不改 worker/child 的 1536 上限（native 峰值不受 V8 cap 约束，改了没用还可能 OOM）；不引入 `--expose-gc` 常驻 GC 循环（收益不确定，先靠 M2 的 isolate 关闭）。
- **测试**：安装模板单测/快照测试若有则更新；lease 并发用既有 `smoke:lease-subprocess` 剧本验证。
- **验证**：部署后触发一次大仓冷建（删 `6496e5a49fd9` 缓存目录的快照再打 impact），监控 D5：daemon+child 合计峰值 ≤ 4 GiB，完成后 10 分钟回落 ≤ D1。
- **出口**：closeout 记 D5 曲线数字。

### M4 — worktree 共用快照：修通 sibling seed 链路（根因已实锤，实现卡）

> **2026-08-25 现场诊断结论（本卡的证据基础，执行者不必重查，直接复用）**
>
> seed 机制早已存在且设计完备（Task 21a，`src/java-index/worktree-snapshot-seeder.ts`）：按 `familyHash`（共享 git common-dir）找兄弟快照，对每个复用文件做 **relativePath + contentHash + sourceRoot 三重逐文件校验**（seeder.ts:233-237），坏边走既有 relink 机制丢弃，产物永远 DEGRADED、必须经强制 reconcile 才升 COMPLETE。家族识别也是通的：lishu-v2 三个缓存目录（1c626986/a72d9f68/abe4393f）`repo-meta.json` 里 `familyHash` 全部为 `97ec2e32dd8a`。
>
> **真正的堵点只有一个**：候选校验 `identityMatches`（`src/java-index/snapshot.ts:264-274`）要求 `buildFingerprint` **逐字节相等**，而 `computeBuildFingerprint`（`src/java-index/build-fingerprint.ts:54-82`）把根目录与每个模块的 10 种 build 标记文件（pom.xml、build.gradle、`.sdkmanrc`、`.java-version`、`.mvn/jvm.config` 等）的内容哈希 + layout 全部揉进一个 sha256。现场实锤：主仓 `/Users/luo/Documents/program/lishu-v2` 有一个**从未提交的本地 `.sdkmanrc`**（17 字节，2026-07-06 创建），任何新 worktree 里都没有这个文件 → 指纹永不相等 → `findCandidate` 0 候选 → `NO_VALID_SOURCE` → 每个 worktree 全量冷建（实测 84s、child 峰值 1.56–1.73 GiB、heap 480 MiB、快照 15.7 MB ×3 份）。一个只影响 JDT JDK 选择、与 tree-sitter 事实毫无关系的文件，一票否决了 1886 个内容完全相同的 Java 文件的复用。
>
> **为什么放宽指纹门是安全的**：指纹门对「own snapshot 直载」是必要的（直载跳过逐文件校验）；但对 sibling seed 是**冗余安全带**——逐文件三重校验已覆盖内容漂移，`sourceRoot` 相等校验已覆盖 layout 漂移，dangling 边有 relink 丢弃，且 seed 结果 DEGRADED + `negativeLookupAllowed:false`，只有 worker 自己的 reconcile 全量扫完才升 COMPLETE。worker 侧注释（java-index-worker.ts:1494-1526）对这条防线有完整论证。

- **目标**：同分支/近分支 worktree 打开时复用家族兄弟快照，`reusedFiles/总文件 ≥ 0.9`，不再触发全量冷建 child。彻底消灭「每开一个 worktree 付一次 1.5–2G 冷建」。
- **改动锚点**（预计 ~120 LOC + 测试）：
  1. **M4a 遥测先行**：`WorktreeScanTelemetry`（seeder.ts:27-30）扩展拒绝原因计数：`metaMissing / selfSkip / familyMismatch / identityMismatch / coverageIncomplete`，`findCandidate` 循环里每个 `continue` 归因；透传到 `WorktreeSeedStatus`（`src/java-index/worker-protocol.ts`）与 `java_status` 输出（`src/tools/status.ts:187-191`），并在 seed 失败时打一行结构化日志。指纹不匹配时,用新导出的 `computeBuildFingerprintEntries()`（把 build-fingerprint.ts 里 sha256 前的 `entries` 数组暴露出来）对比目标侧与候选头无法对比——候选头只有最终哈希——所以日志只记「fingerprint mismatch」+ 目标侧 entries 条数即可，深挖靠 M4a 落地后的现场复跑。
  2. **M4b 放宽 sibling 指纹门**：`loadSiblingSnapshot`（snapshot.ts:287-301）改为 `extractorVersion` + `stableIdVersion` 仍严格、`buildFingerprint` 不匹配**记录但不拒绝**（返回值或 out-param 带 `fingerprintMatched: boolean`，进 `WorktreeSeedStatus`）。`findCandidate` 的 `allHealthyComplete` 门（COMPLETE + 0 failed/recovered）**保留不动**。own-snapshot 路径（`loadSnapshot`，checkRepoRoot=true 那条）**严禁放宽**。
  3. tie-break 微调：候选排序在 `createdAt` 之前先按 `fingerprintMatched` 降序（指纹相等的兄弟优先）。
- **边界**：不改 own-snapshot 校验；不改 seeder 的逐文件校验与 relink 逻辑；不做磁盘快照去重/硬链接（16MB×N 不是痛点）；不做跨 worktree 运行时内存共享（等同一 store 服务多 repoRoot,是架构级改造,写进「天花板」备忘即可）。
- **M4c — JDK pin 文件退出指纹（用户已拍板执行，2026-08-25）**：
  - **动机**：用户不想把本地 `.sdkmanrc` 提交进仓库；`.sdkmanrc`/`.java-version`/`.mvn/jvm.config` 只影响 JDT 的 JDK 选择与 Maven JVM 参数，**不影响 tree-sitter 事实与 layout**,不该参与快照失效判定。（澄清：`.env` 本来就不在清单里，全代码只有 `process.env` 引用，无需处理。）
  - **改动锚点**：仅 `src/java-index/build-fingerprint.ts:14-25` 的 `BUILD_MARKER_RELATIVE_PATHS`，删去 `.java-version`、`.sdkmanrc`、`.mvn/jvm.config` 三行。**不动** `src/repo-change-coordinator.ts` 的 `BUILD_MARKER_NAMES/RELATIVE`（那是 watcher 的 BUILD_CHANGE→JDT 重启清单，两份清单职责不同，已核实相互独立）。
  - **代价（接受）**：指纹输入变化 → 全机现有快照一次性 identity 失效 → 每个 pin 仓一次子进程冷建（2020ee7 已串行化，合计约 3–5 分钟）。**必须在 M4b 之后部署**：这样失效风暴中 worktree 仍可从刚重建好的主仓 seed（指纹门已放宽），只有 pin 主仓付全量。
  - **测试**：`build-fingerprint` 相关单测更新：`.sdkmanrc` 内容变化不再改变指纹；`pom.xml` 变化仍改变指纹。
  - **验证**：部署后确认 4 个 pin 各自重建一次即稳定（`cold-build-metrics.json` mtime 各更新一次）；在主仓放置/修改一个未提交 `.sdkmanrc`，指纹不变（`java_status` 快照不失效）；新建 worktree 无 `.sdkmanrc` 也能 seed 且 `fingerprintMatched=true`。
- **测试**：`src/java-index/worktree-snapshot-seeder.test.ts` 新增用例：(a) 候选指纹不匹配仍可 seed,逐文件校验照常生效（改一个文件的内容 → 该文件进 dirty,其余复用）;(b) extractorVersion 不匹配仍拒绝;(c) 拒绝原因计数正确;(d) 指纹相等候选优先于更新的不相等候选。全量 T0。
- **现场验证（部署后）**：
  1. 确认主仓 lishu-v2 快照健康（`java_status` coverage 全 COMPLETE）。
  2. 删除一个现存 worktree 缓存目录里的 `java-index-snapshot.json.gz`（如 a72d9f68），对该 worktree 打 `java_status` + `java_impact`。
  3. 断言 → **D7 门**：`worktreeSeed.completion ∈ {SEEDED_DEGRADED, RECONCILED_COMPLETE}`、`reusedFiles ≥ 0.9 × 1886`、该缓存目录的 `cold-build-metrics.json` **mtime 不更新**（未 spawn 冷建 child）、OPEN→首查 ≤ 15s。
  4. 新建一个全新 worktree（`git worktree add`）重复 2-3,验证首开路径。
- **出口**：closeout 记 D7 数字（reused/dirty/耗时/是否 spawn child）+ 拒绝原因遥测样本;`docs/phase-d/m4-worktree-seed-closeout.json`。
- **失败处理**：若放宽后 reused 比例仍 < 0.9,用 M4a 遥测归因（大概率是 coverageIncomplete——主仓快照有 recovered 文件——那是主仓索引质量问题,另开卡）;三振后回退 M4b 提交（M4a 遥测保留）,escalation 带遥测数据。

### V1 — 端到端验收（三轨合流后）

- **前置**：W1、S1–S3、M1–M3 全部部署。
- **探针剧本**（写成 `scripts/probe-daemon-acceptance.mjs` 或直接按步骤执行并记录）：
  1. `daemonctl.sh restart` → wait-ready，记录 t0。
  2. 预热期间（t0+5s）打热集仓 `java_impact` —— 允许慢但不许失败（S 轨兜底）。
  3. 预热完成后：4 仓各打 3 次 `java_impact`，记录延迟分布 → D3a/D3b。
  4. storm：`lishu-v2` worktree 跑 `./gradlew classes`，全程 healthz 1s×120 次探测 → D2。
  5. 短 deadline 注入 → D4。
  6. 静置 30 分钟 → `footprint -p` → D1；再访问一个被 M2 关闭的冷仓确认恢复路径。
  7. 冷建剧本 → D5。
  7b. worktree seed 剧本（M4 部署后）：删一个 lishu-v2 worktree 缓存目录的快照 → 重开 → D7。
  8. identity 快检（防 S3/M 轨误伤计划质量）：`npm run benchmark:three-repo-matrix -- --runs 2` 与 `npm run benchmark:three-repo-verify`，与 `main` 基线比对 first-plan 质量轴 identity（本方案任何卡都不该改变正常路径的 plan 内容；若 diff 非空即 FAIL 回查）。执行前按 §0.2(8) 的 load 政策判定。
- **出口**：`docs/phase-d/v1-acceptance.md` + closeout JSON，六门(D1–D6)逐项 PASS/FAIL；任何 FAIL 回到对应卡三振流程。
- **通过后**：更新 `HANDOFF.md`（新增「daemon 生产化三轨」小节与坑清单：git PATH、footprint 度量口径、chokidar 谓词纪律——**任何在每事件路径上的代码不得做同步 fs 调用**）。

---

## 5. 数字门汇总

| 门 | 卡 | 目标 |
| --- | --- | --- |
| D1 | M1/M2 | 稳态 footprint ≤ 900 MiB（追求 700） |
| D2 | W1 | 构建风暴期 healthz P99 < 100ms、0 超时 |
| D3a | S2/M1 | 热 pin 首查 P95 ≤ 3s |
| D3b | S1/S3 | 冷 pin 首查 0 报错、0 retire |
| D4 | S1 | QUERY 超时后 terminations=0、下一请求 ≤ 500ms |
| D5 | M3 | 冷建峰值 ≤ 4 GiB、10 分钟回落 |
| D6 | W1 | 新仓 java_status 首查 ≤ 3s |
| D7 | M4 | worktree 重开 seed 命中：reusedFiles ≥ 0.9×总数、不 spawn 冷建 child、首查 ≤ 15s |
| identity | V1 | 三仓 2-run 快检 plan 内容与基线 identity |

## 6. 风险与回滚

| 风险 | 控制 |
| --- | --- |
| S1 放宽 retire 导致真 wedged worker 长期占位 | 保留 OPEN/变异类 retire；残余靠 daemon 重启；遥测里 `deadlineExceeded` 激增作为告警信号 |
| S2 预热 hydrate 拉高启动期内存 | M1 热集限制在 2 仓；预热串行（2020ee7 已保证） |
| S3 fail-soft 掩盖真实性能退化 | evidence gap 文案唯一可 grep（`Read-range query exceeded`），遥测中可统计出现率；V1 identity 快检确认正常路径无变化 |
| M2 关闭 worker 后首查变慢 | 语义等同既有驱逐路径；S 轨保证不报错；热集豁免 |
| 安装引入回归 | 每卡部署后现场探针 + `daemonctl.sh rollback-release` 单命令回滚（rollback 目录已存在多份，机制已验证） |
| 旧 git 破坏提交/测试 | 合同强制 `PATH="/opt/homebrew/bin:$PATH"` 前缀 |

## 7. 执行顺序

```
W1（半小时，独立可先行）
  → S1 → S2 → S3（同分支连续三卡，S 轨合并一次部署）
  → M1 → M2 → M3（依次部署，M1 依赖 S2 的 hydrate 机制）
  → M4（实现卡，独立于 S/M 其余卡，可与 M 轨并行；根因已实锤见卡内诊断）
  → V1（三轨合流验收 + HANDOFF 更新）
```

预计总量：S 轨 ~300 LOC（含测试改写），M 轨 ~250 LOC + M4 ~120 LOC，V1 探针 ~150 LOC。全程不动 golden、不动 read-plan 正常路径选择逻辑、不 merge main。
