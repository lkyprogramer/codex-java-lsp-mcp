# Worktree Family 内存共享方案（FS 轨）

状态：ADOPTED（R1，2026-08-28）——§6 新增 FS2 落地后三类故障的终局裁决与 FSX 任务卡
前置：`docs/deep/codex-java-lsp-mcp-daemon-stability-and-memory-plan-2026-08-25.md`（R4，已合 main）
触发：用户反馈「每个 worktree ~1.5GB，多项目多 worktree 常开时不可接受，为什么不能共享」

---

## 0. 结论先行

1. **用户的账是对的，且这笔账是新架构独有的。** 旧 main（`48e665ba`，79 个源文件）**没有 `src/java-index/`**——没有索引 worker、没有快照、没有 hydrate。旧版每个 worktree 的常驻内存 ≈ 0（JDT 按需另算）。新架构为每个 repoRoot 起一个独立 index worker 子进程，实测稳态 footprint **483–730 MiB/个**，冷建/hydrate 瞬时峰值 ~1.7 GiB。
2. **当前的「共享」只发生在磁盘（Task 21a sibling seed，18MB gzip），不共享内存。** worker 按 `repoRoot` 隔离（`repo-runtime-manager.ts` `getOrCreate` 以 repoRoot 为 key）；familyHash 只用于 JDT/sweep lease，代码注释明文禁止用于 cache/JavaIndex 身份。
3. **内存共享在数据模型上没有障碍。** `stable-id.ts` 的所有 id 都是 repo 相对路径（`file:src/main/java/...`），root 无关；seed/reconcile 已按 per-file contentHash 校验。同 family 内容相同的文件产出**完全相同的 facts**，可以结构共享。
4. 处置分两层：**FS1（天级）**用生命周期把非热 worker 的常驻窗口从 5–20 分钟压到 ~1 分钟；**FS2（周级）**family 合并 worker + contentHash 结构共享，让每个额外 worktree 的边际内存 ≤100 MiB。两层都保住 F1-N0 已验证的质量/token 收益，不需要回旧版。

### 0.1 现场账本（2026-08-27 21:00 实测）

| 进程 | footprint | 说明 |
| --- | --- | --- |
| daemon（http-server） | 1338 MiB | 呼吸带内封顶（§9.5 裁定） |
| index worker ×4 | 730 / 729 / 710 / 483 MiB | 热 pin 2 个（7h 常驻）+ 近期触碰的 worktree 2 个 |
| JDT LS ×1 | 730 MiB | 按需，另见 J 轨 |

lishu-v2 family 在 cache 下有 **主仓 + 6 个 worktree** 目录。若 3 个 worktree 同时活跃：index 相关 footprint ≈ 2.9 GiB，全部装着几乎相同的 facts。

### 0.2 为什么 700 MiB 而不是快照的 18 MB

- gzip 18MB → JSON 244MB（methods 段）→ hydrate 展开 + intern 后 V8 heap 数百 MB；
- 进程基座（node + V8 + JIT）~100–150 MiB；
- hydrate 瞬时分配把 malloc arena 高水位顶起来，之后不还 OS（与 daemon §9.1 同一机制）。

---

## 1. 方案空间与裁决

| 方案 | 边际内存/worktree | 复杂度 | 判定 |
| --- | --- | --- | --- |
| A. 生命周期压缩（FS1） | 活跃窗口内仍 ~700MiB，窗口后 0 | 低（改 TTL + lease） | **先做**，立即止血 |
| B. family 合并 worker + contentHash 共享（FS2） | ≤100 MiB | 中（store 命名空间化） | **主路径** |
| C. 查询转发主仓 worker + 路径 remap | ~0 | 高 | 否决：主仓 store 被自己的 watcher live 更新，worktree 看到的不是自己 checkout 的事实，正确性硬伤 |
| D. flat binary 列式段 + mmap 跨进程共享 | ~0（物理页共享） | 高（Node 无内置 mmap，需 native 依赖 + 新快照格式） | 远期观察（FS3），FS2 达标就不做 |

C 的否决理由展开：base 必须是不可变快照，而主仓 worker 的 store 是活的（watcher 增量更新、generation 递进）。借用它等于让 worktree 查询看见主仓未提交改动。FS2 规避了这一点：family worker 里每个 root 有自己的 path→facts 视图，共享的只是 **contentHash 相同的不可变 facts 对象**，主仓文件变更时其 facts 换新对象，不影响 worktree 视图指向的旧对象。

---

## 2. 数字门

场景 S：`lishu-v2` 主仓（热 pin）+ 3 个 codex worktree，10 分钟内各跑过 `java_impact`。

| 门 | 现状 | FS1 后 | FS2 后 |
| --- | --- | --- | --- |
| FS-G1：场景 S 查询后 3 分钟，index 相关总 footprint | ~2.9 GiB | ≤ 1.6 GiB（热 2 个 + ≤1 个临时） | ≤ 1.1 GiB |
| FS-G2：worktree 首查 P95（seed 命中） | ~7s（hydrate） | 不劣化 >20% | ≤ 3s（免重复 hydrate） |
| FS-G3：identity（`--runs 2` vs 改动前，三仓 + lishu-v2 抽查） | — | recall/pRead/token P50 delta = 0 | 同 |
| FS-G4：worktree 改动文件的查询正确性 | — | — | 改动文件 facts 来自本 root 的 overlay（定向测试） |

---

## 3. 任务卡

执行合同（分支/提交/closeout JSON/三振规则/load 政策）沿用 daemon plan §3，分支名 `codex/fs-track`。

### FS0：账本分解与重合率探测（0.5 天，只读）

- **目标**：把 700 MiB 拆成 V8 heap / arena / 基座三块；量化 family 内 contentHash 重合率。
- **步骤**：
  1. 对一个活跃 worktree worker 采 `footprint -p <pid>` 全量 + worker 内 `process.memoryUsage()`（可经 STATUS RPC 或临时日志）。
  2. 用现有快照对比主仓 vs 2 个 worktree 的 per-file contentHash（快照里已有；写一次性脚本 `scripts/probe-family-overlap.mjs`，读两份 `java-index-snapshot.json.gz` 解码后统计相同 contentHash 文件占比）。
  3. 产出 `docs/phase-fs/fs0-ledger.json`：`{ workerHeapMb, workerFootprintMb, familyOverlapRatio }`。
- **退出**：overlapRatio 实测落盘。预期 >0.95；若 <0.8，FS2 收益重估，升级 0A.4(4b) 决策。

### FS1：非热 worker 生命周期压缩（1 天）

- **目标**：非热 pin（含全部 worktree）的 index worker 查询结束后 ~60s 内归还内存。
- **锚点**：
  - `src/resource-defaults.ts:14` `DEFAULT_HIBERNATE_TTL_MS = 300000` → 拆成两档：热 pin 维持现状（M2b 豁免不变），非热档新增 `DEFAULT_COLD_HIBERNATE_TTL_MS = 60000`，env `JAVA_LSP_COLD_HIBERNATE_TTL_MS` 可调。
  - `src/repo-runtime-manager.ts` `scheduleIdleShutdown`（~1106–1145）：非热 entry 的 hibernate timer 用新档；M2b 后 hibernate 已走 `recycle()` 拆 isolate，无需新回收逻辑。
  - **family 活跃上限**：同 familyHash 下非热 index worker 同时活跃 ≤1。实现在 `getOrCreate` 创建新 runtime 前检查同 family 非热活跃 entry，超限时对最久未用的先行 `hibernateEntry`。familyHash 取自 `src/worktree-identity.ts`（已有）。
- **边界**：不改热 pin 语义；不改 JDT lease；S5 冷启动预算（15s）保证 hibernate 后首查不报错，只慢一次。
- **验证**：T0 全量 + 定向单测（非热 60s 回收、热 pin 不回收、family 上限触发顺序）+ 场景 S 实测 FS-G1/FS-G2 + FS-G3 identity。
- **失败处理**：若 60s 回收导致 worktree 工作流反复 hydrate 抖动（首查 P95 劣化 >20%），退到 120s；再不行只保留 family 上限、撤 TTL 改动。

### FS2：family 合并 worker + contentHash 结构共享（1–2 周，主路径）

- **目标**：同 family 所有 root 共用一个 index worker 进程；facts 按 contentHash 去重，worktree 边际内存 ≤100 MiB。
- **设计要点**：
  1. **client 拓扑**：`JavaIndexClient` 的 worker 进程按 familyHash 复用（新 `FamilyWorkerPool`，位于 `java-index-client.ts` `createWorker`/`spawnAndOpen` 之上）；每个 root 仍有自己的 client 逻辑态（generation、snapshot 路径、coverage），RPC 增加 `rootId` 字段（`worker-protocol.ts`）。
  2. **worker 侧**：`java-index-worker.ts` 持 `Map<rootId, JavaIndexStore>`；`JavaIndexStore` 增加共享 facts 池（`Map<contentHash, FileFactsBundle>`，familyHash 级单例）。ingest/reconcile 时：contentHash 命中池则直接引用（跳过解码/intern），未命中才解析并入池。池条目引用计数，root 关闭时递减，归零驱逐。
  3. **正确性**：facts 对象视为不可变（现有代码不原地改 facts，需在卡内以单测锁定）；文件变更 = 新 contentHash = 新对象，旧 root 视图不受影响。
  4. **隔离代价**：OOM 爆炸半径从单 root 变成单 family——可接受（S3 自动重启 + 池化后总 heap 反而更小）。1536 cap 不变：base ~400 MiB + N×overlay 远低于 cap。
- **边界**：不动快照格式；不动 seed（Task 21a）；不动 daemon 侧工具语义；跨 family 不共享。
- **分步提交**：(a) RPC rootId + FamilyWorkerPool（单 root 时行为等价，identity 必须 0 delta）；(b) 多 store 同进程；(c) contentHash 共享池。每步独立 T0+identity。
- **验证**：T0 全量；定向单测（同 family 两 root 差异文件互不可见、共享池引用计数、root 关闭驱逐）；场景 S 实测 FS-G1（≤1.1 GiB）、FS-G2（≤3s）、FS-G4；FS-G3 identity 三仓 + lishu-v2 主仓/worktree 各一。
- **失败处理**：三振后保留 FS1 成果，FS2 降级为「(a)+(b) 不做 (c)」（仅省进程基座 ~150 MiB/worktree）并升级 0A.4(4b) 记录。

### FS3（远期观察，不排期）

flat binary 列式段 + mmap 只读共享。仅当 FS2 后单 family base 仍成为多项目瓶颈时评估；需引入 native mmap 依赖 + 快照格式 v6，成本高，当前不做。

---

## 4. 「回到之前的版本」的对照表

| | 旧 main（无 JavaIndex） | 现状 | FS1 后 | FS2 后 |
| --- | --- | --- | --- | --- |
| worktree 常驻内存 | ~0 | 700 MiB×N（20 分钟窗口） | 700 MiB×≤1（1 分钟窗口） | base 共享 + ~100 MiB×N |
| java_impact 质量/token | F1-N0 基线以下（token 高、recall 低） | F1-N0 GO 水平 | 同 | 同 |
| 首查延迟（worktree） | 无索引路径 | ~7s | ~7s（每次窗口过后重付） | ≤3s（免 hydrate） |

即刻逃生门（不等 FS 轨）：`JAVA_LSP_INDEX_IDLE_TTL_MS` 调小 + 从 `projects.json` hot 集合里移除不常驻的仓，即可把常驻压到接近旧版水平，代价是每次冷首查 ~7s。

## 5. 执行顺序

FS0 → FS1（止血，先上线）→ FS2(a)(b)(c) → 场景 S 终验 → 合 main。J 轨（JDT，daemon plan §9.6）与 FS 轨独立，可并行。

---

## 6. FS2 落地后终局裁决（R1，2026-08-28）

### 6.1 现场证据（`codex/fs-track` 16 commits，live 951e1e7）

FS0 实测 familyOverlapRatio **0.986**；FS2 已落 FamilyWorkerPool + donor overlay（`attachFromDonorStore` O(1) 引用）+ donor graph/search 复用（QUERY_CONTEXT_GRAPH 107ms vs 3982ms 建图）。但场景 S 仍 FAIL，`daemon.stderr.log` 揭示**三类叠加故障**：

1. **family worker OOM（heap 1459MB 撞 1536 墙）**：`java-index-worker.ts` OPEN 路径对**有自己磁盘快照的 root 仍做全量 own-snapshot hydrate**（6 个 lishu-v2 worktree cache 全有 16–19MB 快照）。donor 共享只覆盖 graph/search 与无快照 root 的 seed。donor（~650MB）+ N×own hydrate（各数百 MB）+ graph 装进一个 1536 进程 → OOM。grok 实测 G1 2006MB footprint 即此。
2. **daemon OOM（heap ~850MB 撞 run-daemon.sh 的 `--max-old-space-size=768` 墙）**：日志共 12 次 `FATAL ERROR: Reached heap limit`，多数 pid 在 prewarm(pins=4) 完成后 78–186s 崩溃。launchd KeepAlive 静默重启（ThrottleInterval 10s），表现为「所有 repo 突然 15s 超时」——遥测里 lishuedu java_status 15002ms FAIL 与 ee80 首查同窗即此。**成分未取证**（嫌疑：fork IPC 大响应物化、family pool 重试风暴放大）。
3. **`spawn EBADF`（fork family worker 失败，errno -9）**：无 fsevents 时 chokidar 逐目录 `fs.watch` 占 fd；4 pin（lishuedu 目录数万计）常驻数万 fd，fork 时命中 EBADF。`run-daemon.sh` 注释早已自证（"Pin watchers … can hold thousands of source FDs"）。prewarm 期间 cipherlink worker spawn 直接失败。

ee80 首查 19568ms（遥测，coldPath heuristic 优雅返回 0 items）≈ own hydrate 排队 + daemon 崩溃窗口；grok 目测的 55.2s 包含 daemon 重启期。**修复 (1) 后此项预期自然消失，仍需回归验证。**

### 6.2 裁决

- FS2 的「family 合并进程」方向正确（graph 复用已证 37 倍加速），但**合并进程放大了不彻底共享的代价**：以前 4 个 root 各自 700MB 分散在 4 个进程，现在挤进一个 1536 进程立即爆。**base 单例化不是优化项，是合并进程的前置条件**——必须让同 family 的 facts 在进程内只有一份。
- daemon 768 cap 是 §9 时代按「daemon 只做路由」定的；FS2 后 daemon 是否多了大 heap 路径必须取证后再动 cap，不允许无证据抬 cap 掩盖泄漏。
- EBADF 与 FS 轨无关但被 prewarm+family spawn 放大，独立成卡。

### 6.3 FSX 任务卡

**FSX0：三点取证（0.5 天，只读，先行）**
- daemon：run-daemon.sh 临时加 `--heapsnapshot-near-heap-limit=1`，复现 prewarm 后 OOM，用 heap snapshot 钉出 daemon ~850MB 的 retainer（嫌疑顺序：IPC 响应物化 > family pool 句柄 > telemetry/watcher）。
- worker：STATUS RPC 补 `heapUsedMb` 分解（donor store / 各 root store / graph），场景 S 各步采样落 `docs/phase-fs/fsx0-heap-ledger.json`。
- fd：`lsof -p <daemon pid> | wc -l` 在 prewarm 前后采样，按类型（kqueue/dir/file）分桶。
- 退出：三个数字落盘；FSX2/FSX3 的目标数值由此校准。

**FSX1：watcher fd 治理，消灭 EBADF（1 天）**
- 首选：引入 `fsevents`（macOS 原生，单 fd per watch root；chokidar 检测到即自动使用）为生产依赖；`package.json` optionalDependencies + 安装脚本校验。
- 兜底（若 fsevents 与 Node 22 ABI 有问题）：watcher 范围收敛到 `sourceRoots`（现在 watch 整个 repoRoot），lishuedu 类超大仓的 fd 数量级下降。
- 门：prewarm 4 pins 后 daemon fd 总数 ≤ 2000；重复 20 次 family worker spawn 0 EBADF。

**FSX2：family base 单例化（3–5 天，主卡）**
- 核心改动：`java-index-worker.ts` OPEN 路径——root 属于已有 donor 的 family 时，**跳过 own-snapshot 全量 hydrate**，改为：donor overlay 引用（已有 `attachFromDonorStore`）+ 对 own 快照逐文件 contentHash 对比，仅差异文件（FS0 实测 ~1.4%）物化进本 root overlay；其余引用 donor 池对象。
- 覆盖语义：seed 后 coverage 直接 COMPLETE（per-file contentHash 已校验，与 Task 21a reconcile 同一信任链）；watcher 增量走本 root overlay，不碰 donor。
- donor 生命周期：donor root 关闭时若仍有依赖 root，store 保留（引用计数），仅拆其 watcher/session 壳。
- 门（场景 S）：family worker 稳态 heap ≤ donor+250MB（FSX0 校准后定死数字）；G1 总 footprint ≤ 1.1GiB；G2 worktree 首查 P95 ≤ 3s 且候选非 0；G4 worktree 改动文件差异可见性定向单测；identity 三仓 0 delta。
- 失败处理：三振后回退到「family 合并进程仅限无 own 快照的 root，有快照的 root 退回独立 worker」（保住 FS1 收益），升级 0A.4(4b)。

**FSX3：daemon heap 治理（取证后 0.5–1 天）**
- 按 FSX0 heap snapshot 结论修真源（若是 IPC 物化：大响应改流式/分块或裁剪 payload；若是重试风暴：spawn 失败退避）。
- cap 裁决：修复后 daemon 稳态 heap 若 ≤400MB，768 维持；确有合理新增（family pool 常驻）则一次性调至 1024 并在 run-daemon.sh 注释记账。
- 门：连续 3 次 restart+prewarm+场景 S，0 次 daemon FATAL；`HTTP daemon ready` 在 24h 内出现次数 ≤ 安装次数+1。

**FSX4：崩溃可观测性（0.5 天，随 FSX3 合并提交）**
- daemon/worker `process.on("exit"/"uncaughtException")` 前落一行结构化 crash 标记；`probe-daemon-acceptance.mjs` 断言测试窗口内 0 FATAL / 0 EBADF（此前 12 次 OOM 全被 KeepAlive 掩盖，靠翻日志才发现，不可接受）。

### 6.4 执行顺序（替代 §5，自 R1 起）

FSX0（取证）→ FSX1（EBADF）→ FSX2（base 单例化）→ FSX3+FSX4（daemon 治理+可观测）→ 场景 S 终验（G1–G4 + 0 FATAL + 0 EBADF）→ 合 main。ee80 首查回归在 FSX2 门内验证，不单独设卡。
