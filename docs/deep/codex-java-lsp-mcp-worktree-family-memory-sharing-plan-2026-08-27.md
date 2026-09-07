# Worktree Family 内存共享方案（FS 轨）

状态：SUPERSEDED（2026-09-06）——§9 FSR0–FSR4 卡**全部作废**，由 `codex-java-lsp-mcp-index-on-disk-rearchitecture-plan-2026-09-06.md` 取代：FSR 24h 窗（`docs/phase-fs/fsr-24h-soak-report-2026-09-06.md`）证明相对阈值换气自身成为故障源（基线不刷新 → 连打 8 次 → skip 帽把 lishu-v2 打成 43 文件空壳 24h），且 FSR0 归因实际在 2 文件 fixture 上完成、无决策价值。本文 §0–§8 保留为历史记录。原 R4 状态行：§9 新增 FSZ 48h 编辑负载窗的真因（堆主体未归因 + 表示路径不对称 + 冷建链三连错）与 FSR 收尾卡；§8 为零调用窗根因与 FSZ 卡；§7 为 48h 观察窗裁决与 FSY 卡；§6 为 FS2 三类故障与 FSX 卡
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

---

## 7. 48h 观察窗裁决与 FSY 收尾卡（R2，2026-08-30）

### 7.1 FSX 落地核验（live bf2ee08，2026-08-28 15:24 部署）

FSX 实际落地与 R1 字面有三处**已接受的偏离**（2026-08-28 评审裁定）：

1. **FSX1 未加 fsevents 依赖**，Darwin 改用 Node `fs.watch({recursive:true})`（底层同为 FSEvents，一 watch root 一 fd）。裁定：优于原方案（零新增 native 依赖），门已过（fd 76–148）。**后续 AI 不得按 R1 字面补装 fsevents。**
2. **FSX0 未跑 near-heap snapshot**，retainer 由既有 V8 dump 钉在 JsonStringify；heapSplit 是计数不是字节账。裁定：取证不完备但当时结论成立；字节账并入 FSY2。
3. **FSX3 未做 IPC 流式**，daemon 稳态修 watcher 后已 <400MB，768 维持。裁定：当时正确；但见 §7.2——该债务 48h 内被真实触发。

### 7.2 48h 观察结果（2026-08-28 15:24 → 2026-08-30 10:10）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| daemon 存活 | **PASS**：同一 pid 50992 连跑 42.7h，0 重启 | `ps etime` 01-18:44；最后一条 `daemon ready` 在当前进程（log:1534） |
| daemon 内存/fd | **PASS**：footprint 80→102 MiB 无棘轮，RSS 27 MiB，fd 80 | 对比 §9.5 时代 1346 MiB 呼吸带——watcher 状态即当年 footprint 呼吸主因，D1「呼吸天花板」条款自本裁决作废 |
| EBADF | **PASS**：0 新增 | 最后一次 EBADF 在 log:1436（当前进程启动前） |
| worker FATAL | **FAIL（1 次，自愈型）**：热 pin worker pid 51048 运行 40.8h 后 heap 1530 MiB 撞 1536 墙 OOM | log:1552 GC dump；崩溃栈顶 `JsonStringify`（ArrayMap → stringify → OOM） |
| 遥测连续性 | **FAIL**：`~/Library/Caches/codex-java-lsp/telemetry/` 目录整体消失，48h 调用质量数据丢失 | 2026-08-28 尚存 `impact-20260828.jsonl` |

**裁决**：故障等级已从「全局瘫痪」（12 次 daemon OOM + KeepAlive 循环）降到「单 worker 自愈」（daemon 无感、下次查询自动重建）。但严格 0 FATAL 门未过，且崩溃机制清楚：**worker 长跑 heap 爬升（启动数百 MB → 40h 后 1.5 GiB）+ 一次大 JsonStringify 压垮**。stringify 是最后一根稻草，爬升是真问题。合 main 前先落 FSY1/FSY2。

### 7.3 FSY 任务卡

**FSY1：worker heap 阈值自愈（1 天，止血，合 main 前必做）**
- 核心：worker STATUS 已带 heap 数据的基础上，daemon 侧（`repo-runtime-manager.ts` 或 client 心跳处）检测 worker `heapUsedMb > 1200`（cap 1536 的 78%）时，标记该 entry 在**空闲时刻**（activeRequests=0 且非查询窗口）主动 `recycle()`。S5 冷启预算保证重建后首查不报错，热 pin 重建走既有 prewarm hydrate 路径。
- 边界：不抬 1536；不在查询中途杀 worker；阈值 env `JAVA_LSP_WORKER_HEAP_RECYCLE_MB` 可调，0 关闭。
- 门：单测（阈值触发、查询中不杀、重建后可查）；模拟压 heap 到阈值验证有序换气；identity 三仓 0 delta。
- 失败处理：若空闲窗口判定复杂，退化为「阈值触发后仅打结构化告警日志」，把换气交给下一张卡的根因修复。

**FSY2：长跑 heap 爬升取证 + stringify 债务清偿（2–3 天，根因）**
- 取证：STATUS 增加字节级 heap 分解（donor store / root overlays / graph / parse-tree cache / 其他），probe 脚本每 6h 采样落 `docs/phase-fs/fsy2-heap-growth.jsonl`；钉出 40h 从数百 MB 爬到 1.5 GiB 的成分（嫌疑顺序：reconcile 残留引用 > graph/entity 索引增长 > parse tree cache 边界失效 > IPC 缓冲累积）。
- 修复：按取证结论修真源；同时清偿 JsonStringify 债务——worker 侧超大响应（>32 MiB 序列化产物）改分块或裁剪，禁止一次性 stringify 无界 payload（锚点：崩溃栈对应的 IPC 响应序列化处，FSX0 dump 已在案）。
- 门：修复后模拟 48h 等效负载（加速回放 reconcile/查询循环），worker heap 增长斜率 ≤ 50 MiB/24h；0 FATAL。
- 失败处理：三振后接受 FSY1 的定期换气作为长期机制，把本卡降级为观察项并升级 0A.4(4b) 记录。

**FSY3：遥测目录消失取证（0.5 天，随 FSY2 提交）**
- 查 `telemetry/` 被谁删（嫌疑：`worktree-cache-cleanup.ts` 清扫范围过宽 > release 安装脚本 > 手工误删）；修复后 telemetry 写入点加目录自愈（不存在则重建）。
- 门：连续两次 daemon restart + 若干查询后 `impact-*.jsonl` 存在且追加正常；cleanup 单测覆盖「不得触碰 telemetry/」。

### 7.4 合 main 前置清单（替代 §6.4 尾部「合 main」条件）

1. FSY1 落地并过门（必做）。
2. FSY3 落地（遥测恢复，否则下一个观察窗又是盲的）。
3. FSY2 至少完成取证部分（成分账落盘）；根因修复可作为合 main 后首个跟进项，但 stringify 无界 payload 上限必须在合并前落地（它是已两次现身的确定性风险）。
4. 重跑 24h 干净窗（0 daemon FATAL、0 EBADF、worker 0 撞墙崩溃——FSY1 的有序换气不计为 FAIL，但换气次数入账，24h 内 >3 次视为 FSY2 未收敛）。

---

## 8. 零调用 24h 窗 FAIL：根因闭环与 FSZ 生产级收尾卡（R3，2026-09-01）

### 8.1 事实（live 0f9cc14，窗口 2026-08-30 → 08-31）

用户 24h 内**一次 MCP 调用都没有**，lishu-v2 family worker（pid 22417）仍从 784 MiB 爬到 1103 MiB，运行 30.5h 后 heap 1442 MiB 撞 1536 墙 OOM（log:1638，栈顶 JsonStringify ← ArrayMap，与 40.8h 那次同型）。lishuedu 全程 484 MiB 平线。FSY1 换气 0 次。daemon 本体、EBADF、telemetry 三项 PASS。

### 8.2 根因闭环（三个环节各错一处，已全部对上代码）

1. **增长源：列式存储墓碑无回收 + intern 表 append-only。** `columnar/*.ts` 的 `remove` 只置 `deleted[row]=1`，行永不回收；`add` 永远追加新行；`StringTable` 只增。watcher 驱动的 REFRESH（`handleRefresh` → `replaceFile`）每轮编辑都墓碑旧行、追加新行、intern 新字符串，再对 dependents `resolveAndBuildEdges` 放大。**用户在 lishu-v2 写代码（不调工具）即触发**——爬升与工作时段强相关（白天 +270 MiB、夜间 +25 MiB），lishuedu 无编辑故平线。SharedFactsPool 的 refcount/归零驱逐本身正确（index-store.ts:376/950/965/980 均有 release），不是泄漏点。
2. **致命稻草：快照编码全量物化。** `snapshot-v4.ts:165` `parts.map(part => JSON.stringify(part))` 把所有分块的 JSON 字符串同时驻留内存。S4 分块只救了解析侧（hydrate），编码侧仍是全量。REFRESH 后的 `scheduleSnapshotFlush` 在高水位上执行它 → OOM。FSY2 的 32 MiB stringify 上限只盖了 IPC 响应，没盖快照编码。
3. **看护失效：FSY1 是边沿触发。** heap 阈值检查只挂在工具请求结束后，零调用 → 阈值永远不被看见。两次 OOM（40.8h / 30.5h）全部发生在无调用的后台路径上，这个挂载点选错了。

另записано：本窗 prewarm 时主仓快照因 `snapshot identity mismatch` 被丢弃、seed 走 d10f worktree——快照身份的脆弱性是独立问题，列入 FSZ4 取证范围，不阻塞。

### 8.3 FSZ 任务卡（生产级收尾，全部合 main 前完成）

**FSZ1：heap 看护改周期心跳（0.5 天，兜底，最先落）**
- daemon 侧每 5 min 对活跃 index worker 发 STATUS（或复用现有心跳），`heapUsedMb > JAVA_LSP_WORKER_HEAP_RECYCLE_MB`（默认 1200）且 activeRequests=0 即换气（`recycle()`；热 pin 换气后走既有 prewarm hydrate 重建）。彻底去掉「工具请求结束」这个边沿依赖。
- 门：单测（定时触发、查询中不杀）；模拟压 heap 验证零调用场景下换气发生；换气事件落结构化日志（计数入 24h 窗账本）。

**FSZ2：快照编码流式化（0.5–1 天，消灭致命稻草）**
- `snapshot-v4.ts` `encodeSnapshotV5`：逐 part `JSON.stringify → gzip → append 写盘`，任何时刻只驻留一个 part 的 JSON 字符串；禁止 `parts.map(stringify)` 数组物化。格式不变（V5 读取端无感）。
- 门：单测（大 store 编码峰值 heap 增量 ≤ 单 part 大小 ×2）；编码产物与旧实现字节等价或可被现有 `readSegment/readSegmentChunks` 正确读回（roundtrip 测试）。

**FSZ3：REFRESH 增长有界化（1–2 天，治本）**
- 首选（工程性价比）：**墓碑比例触发的空闲重建**——STATUS 增加 `tombstoneRatio`（deleted 行 / 总行）与 `stringTableBytes`；任一超阈值（默认 tombstone > 0.35 或列字节 > 启动值 ×1.5）且空闲时，worker 原地重建列（新 SoA 只复制存活行 + 重建 intern 表），不换进程、不丢 store 状态。
- 兜底：若原地重建实现风险高（引用 row index 的地方多），退化为「阈值触发 FSZ1 的换气」——换气本身就是终极 compaction，代价是热 pin 一次 ~7s 重建。
- 门：模拟 500 轮 REFRESH（脚本回放同一批文件反复改写），heap 增长有界（触发重建/换气后回落到基线 ±10%）；identity 三仓 0 delta。

**FSZ4：增长字节账与快照身份取证（0.5 天，随 FSZ3 提交）**
- 补齐 FSY2 承诺未兑现的字节级分解：STATUS heapSplit 落真实值（列字节、intern 表字节、墓碑比例、knowledgeBuilder/entitySearch 各自字节——后两者的增量语义是否 append-only 在此一并取证），`fsy2-heap-growth.jsonl` 改为生产 worker 每 6h 自动采样。
- 查 prewarm 丢弃主仓快照的 `snapshot identity mismatch` 触发条件（嫌疑：分支切换/commit 变动使身份过严），单独出结论，若确认过严则另立小卡。

### 8.4 生产级验收（替代 §7.4 第 4 条）

**编辑负载 48h 窗**（不再是安静窗——安静窗测不出这条链）：窗口内正常在 lishu-v2 写代码，结束时同时满足：
1. 0 daemon FATAL、0 EBADF、0 worker 撞墙崩溃；
2. 换气/重建事件有序且 ≤3 次/24h，每次后 heap 回落到基线 ±10%；
3. `fsy2-heap-growth.jsonl` 连续采样显示 heap 有界（无单调爬升段超过 12h）；
4. 期间抽查 java_impact 正常（延迟、候选数与基线一致）。
全绿后合 main 并生产切流；任何一条不过，回到 FSZ3 的失败处理路径重新裁决。

---

## 9. FSZ 48h 编辑负载窗：真因与 FSR 收尾卡（R4，2026-09-03）

### 9.1 窗口事实（live 6148de2，`docs/phase-fs/fsz-48h-soak-report-2026-09-03.md`）

FSZ 对准的那条链**已死**：0 FATAL、0 EBADF、0 撞墙；lishu-v2 在 +111 文件编辑负载下 48h 净 +120 MiB，intern 锁死 72 MiB、墓碑被 compact 压回、快照流式编码未再出现 JsonStringify 栈。查询抽查 133–153 ms、heap Δ0。**FSZ1–4 各自的机制都成立。**

窗口仍 FAIL 的三件事，逐一拆解后发现真正的问题在 FSZ 没覆盖到的地方：

| 现象 | 报告归因 | 真因（本节） |
| --- | --- | --- |
| lishuedu 484 → 1139 阶跃后 22h 不回落 | 「一次指纹丢快照后重建」 | 冷建链三连错（§9.3）+ 表示路径不对称（§9.2）|
| compact 23 次 / 换气 0 次 | 「计数口径」 | 口径确实错，但 FSZ1 阈值 1200 绝对值在 1139 平台下等于没有看护（§9.4）|
| lishu-v2 otherBytes 576 → 729 MiB | 「V8 / 解析残留」 | **堆主体 75% 未归因**——这才是本窗最重要的发现（§9.2）|

### 9.2 真因一：堆主体未归因，且表示随到达路径不同

heapSplit 已归因项（columnar 20M + stringTable 75M + graph 40M + entitySearch 49M + donor 30M + parseTree 2M）合计 ~216 MiB，而 lishu-v2 heap 894、lishuedu 1139——**`otherBytes` 占 75–78%**。FSZ3 的 compact 只作用在已归因的 ~15% 上，所以「墓碑清了、intern 锁了、heap 不动」是必然结果，不是 compact 失效。

决定性对照：lishuedu 同一批 6.1k 文件，**从快照 hydrate 出来 484 MiB；进程内 parse 重建出来 1135 MiB**。同一份 facts、2.3 倍堆。代码层面已定位到的不对称与无界结构：

1. **`RangePool.memo`（`columnar/range-pool.ts`）**：`Array<SourceRange|undefined>` 按 handle 追加、handle 永不释放；`byteSize()` 只计 coords/buckets 两个 typed array，**memo 里的 JS 对象完全不计**。编辑造成的行号偏移让每个 REFRESH 都产生新 range → 新 handle → memo 永久增长，全部落入 otherBytes。compact 是否重建 RangePool 待核（8500eef 改了 13 行）。
2. **parse 路径 bundle 肥、hydrate 路径 bundle 瘦**：`refreshFile` → `parseJavaSourceFile` 产出的 `JavaFileBundle` 带完整 callSites/typeRefs/annotations/imports 对象数组，经 `replaceFile` → `internOrShare` 进 `installedBundles` 与 SharedFactsPool 后**整个对象图长期保留**；hydrate 路径的 bundle 由 `publishHydratedToPool` 用 `files()` 从列式物化（d30ddc3 还把 method maps 做成 lazy）。SharedFactsPool.estimatedBytes 用 `methods×220B` 一类常数估算（lishuedu 6.1k 文件估 35 MiB），与真实对象图相差一个数量级，把肥 bundle 全部藏进了 otherBytes。
3. **`resolveAndBuildEdges` 每文件两次 `replaceFile` + 两次 `rebuildRegistry()`**（`java-index-worker.ts:969-998`）：`rebuildRegistry` 是 `[...typesById.values()]` 全量物化整个类型注册表。6k 文件进程内重建 = 1.2 万次全量注册表构建，CPU 与瞬时分配都是 O(N²)。这是 300 s 冷建的主因之一，也是「进程内重建把热 worker 拖成 1135 平台」的放大器。
4. **`knowledgeBuilderBytes` 恒为 0 是「未测量」不是「为零」**（报告原话「按设计不在热路径累加」）。`syncKnowledgeGraphBundle` 每 REFRESH 都喂它，其保留量未知。

**结论**：稳态堆的大小取决于 facts 是怎么到达的，而不是 facts 有多少。任何走 parse 的路径（REFRESH、进程内冷建、reconcile 差异文件）都留下肥表示，且现有 compact 不会把肥转瘦。这就是 lishu-v2 慢爬（编辑越多肥越多）与 lishuedu 阶跃（一次全量 parse 全肥）的共同根。

### 9.3 真因二：lishuedu 冷建链三连错（同一事件、三处独立缺陷）

`build.gradle.kts` 加一行依赖 →
1. **buildFingerprint 变 → 整份快照 `rm`**（`java-index-worker.ts:1099-1153`）。M4b 已对 sibling seed 放松了指纹要求（靠 per-file contentHash 兜底），**own 快照仍是字节级严格匹配**。构建文件只影响 layout 推导（source roots / modules / generated roots），而 layout 变化本身就能被 reconcile 发现（新 root 的文件是新路径、消失 root 的文件是删除）。指纹作为快照有效性的门是多余的。
2. **子进程 300.55 s 被 300 s 硬超时 SIGKILL**（`COLD_BUILD_CHILD_TIMEOUT_MS=300_000`，`java-index-worker.ts:1651`）——快照已在 11:16–17 写完 28 MB。超时既是绝对值（不随文件数缩放），又不看进度、不看产物。
3. **子进程「失败」后回退到热 worker 进程内全量 parse**——这正是 M3 用子进程隔离冷建要避免的事。回退方向错了：应该是 files-only + 后台重试子进程，而不是把 6k 文件的肥表示塞进常驻 isolate。

### 9.4 真因三：看护与验收口径

- FSZ1 阈值 1200 是绝对值。lishuedu 在 1139 平台停 22h、距墙 397 MiB、距阈 61 MiB——任何一次 registry 重建或查询突发都可能越线，但心跳永不开火。阈值必须相对于本 worker 的 **hydrate 后基线**（如 ≥1.6×）或由事件触发（进程内重建完成即换气），而非绝对数。
- 采样器把每条 compact 日志计为一次「重建」、把 +8 MiB/13h 与 +650 MiB 阶跃都判成「爬升」。compact 是内部维护动作，不应入验收账；阶跃与斜坡应分开判定。

### 9.5 FSR 任务卡（R = representation & rebuild）

**FSR0：真实堆归因（1 天，只读，先行且不可跳过）**
- 在与生产同规模的 lishuedu/lishu-v2 上（可用隔离 daemon 实例），对 worker 触发 `v8.writeHeapSnapshot`（新增 STATUS 子命令或 SIGUSR2），分别在「hydrate 后」「进程内重建后」「48h 编辑负载后」三个状态各取一份，按 constructor 聚合 retained size：`JavaMethodFacts / JavaCallSiteFact / JavaTypeRef / SourceRange / Map / Set / string / Array`，并按 retainer 路径归到 `installedBundles / SharedFactsPool / RangePool.memo / knowledgeBuilder / entitySearch / registry`。
- 顺带核：compact 是否重建 RangePool；`buildTypeRegistryView` 返回值是否被任何长期结构引用。
- 产出 `docs/phase-fs/fsr0-heap-attribution.json`；heapSplit 改为按此结论给出真实字节（含 rangePoolMemoBytes、bundleObjectBytes、knowledgeBuilderBytes、registryBytes），`otherBytes` 目标 ≤ 15%。
- 退出：三态归因落盘；FSR2 的实施顺序按 retained size 排序确定。

**FSR1：冷建链三处修复（1–2 天，独立于归因结果，可并行）**
- (a) own 快照的 buildFingerprint 不再作为 discard 条件：mismatch → 正常加载 + 强制全量 reconcile（复用 M4b/Task 21a 的 per-file contentHash 信任链 + layout 重推导对比）。仅 `extractorVersion / stableIdVersion / schemaVersion` 三者保留 discard 语义。
- (b) 子进程超时改为**进度型**：子进程每完成一个阶段/每 N 文件向父进程写一行进度；父进程只在「无进度 ≥ 120 s」时 kill，取消绝对上限；kill 前先检查目标快照是否已完整落盘（校验尾部/manifest），若已落盘则按成功处理。
- (c) 子进程真失败时的回退改为：保持 files-only（coverage DEGRADED）+ 指数退避重试子进程（最多 3 次）+ S5/coldPath heuristic 继续给出可重试的降级响应。**禁止**在常驻 worker 内做超过阈值（默认 500 文件）的进程内全量 parse。
- 门：单测（指纹变更不丢快照、进度型超时、慢子进程在完成线不被误杀、失败回退不进进程内 parse）；实测：改 lishuedu 根 `build.gradle.kts` 一行 → 无 discard、无子进程、reconcile 完成后 heap 与改前 ±5%。

**FSR2：表示路径归一（3–5 天，主卡，按 FSR0 排序实施）**
- 目标：稳态堆与 facts 到达路径无关——parse 路径产出的 facts 在进入 store 后必须与 hydrate 路径同形。
- 首选实现：REFRESH/reconcile 的 `replaceFile` 在 intern 进列式后**丢弃肥 bundle 对象**，`installedBundles`/SharedFactsPool 改持有从列式物化的瘦 bundle（与 `publishHydratedToPool` 同一来源）；RangePool.memo 改为 LRU 或按 compact 重建（handle 回收）；`rebuildRegistry` 改增量维护（typesById 变更时局部更新注册表，或至少按 REFRESH 批次缓存一次而非每文件两次）。
- 备选（若首选在 FSR0 后证明改动面过大）：**事件触发换气**——任何进程内 parse 超过阈值文件数（默认 200）或肥 bundle 比例超阈值时，flush 快照后在空闲时刻 recycle，让 hydrate 路径把表示归一。这等价于把「表示归一」交给快照往返，代价是热 pin 一次 ~7 s 重建。
- 门：lishuedu「hydrate 后」与「进程内重建 + 归一后」heap 差 ≤ 15%（现为 2.3×）；lishu-v2 模拟 500 轮 REFRESH 后 heap 回到 hydrate 基线 ±10%；identity 三仓 0 delta。

**FSR3：看护改相对阈值 + 事件触发（0.5 天，随 FSR1 提交）**
- FSZ1 心跳阈值改为 `max(JAVA_LSP_WORKER_HEAP_RECYCLE_MB 的显式值, 1.6 × 本 worker hydrate 后 heapUsed)`，默认关闭绝对 1200；新增事件触发：进程内 parse 文件数超阈值后的下一个空闲窗必换气。
- 门：lishuedu 复现 §9.3 场景（若 FSR1 未落地前）时，重建完成后 ≤10 min 内换气回 484±10%。

**FSR4：验收口径重定义（0.5 天，随 FSR3 提交，替代 §8.4）**
- compact 不入账；分别计「recycle 事件」「cold-build 子进程事件」「进程内 parse 事件（应为 0）」。
- 爬升判定改为**相对 hydrate 基线**：任一热 worker heap > 1.4 × 基线持续 ≥ 6h 为 FAIL；阶跃（单拍 > +30%）单独标记并要求 24h 内回落。
- 48h 编辑负载窗 PASS 条件：0 FATAL / 0 EBADF / 0 进程内 parse 事件；recycle ≤ 2 次/24h 且每次回落到基线 ±10%；heapSplit otherBytes ≤ 15%；查询抽查通过。

### 9.6 执行顺序与合 main

FSR0（归因）‖ FSR1（冷建链）→ FSR3+FSR4 → FSR2（按 FSR0 排序）→ 48h 编辑负载窗（§9.5 FSR4 口径）→ 合 main。

FSR0 与 FSR1 互不依赖、并行开工；FSR2 必须等 FSR0 的 retained-size 排序，不允许再按猜测挑结构改。若 FSR0 显示 otherBytes 主体不在 §9.2 列出的四项里，回到本节重新裁决而不是硬做 FSR2。
