# 索引生命周期 review 与修复（2026-11-10）

范围：静态索引的生成（全量）、增量、更新（发布/绑定）、删除（回收）。基线 `cc5db6b`，分支 `fix/index-lifecycle-review`。

## 验证状态

| 项目 | 状态 |
|---|---|
| 类型检查 `npm run build:isolated` | 未运行：本机资源不足（tsc 被杀），且产品依赖 macOS 原生组件 |
| 单元/集成测试（含本轮新增/修改的测试） | 未运行：原因同上 |
| Mac 实机复现 | 未运行：无 Mac |
| 独立 review | 已运行，见文末"review 记录" |

所有触发条件都来自读代码推断，没有复现。合入前建议在 Mac 上依次运行：
- `snapshot/*.test.ts`
- `builder/incremental.test.ts`
- `build-fingerprint.test.ts`
- `scripts/ilv2-mac-full-delta.mjs`

## 已修复

### F1（P1）单文件解析异常 → 增量永久失败、每秒重试

- **位置**：`java-index-file-parse.ts`、`ast-extractor.ts`、`cold-build.ts`。
- **触发**：读取成功之后，提取器对某个文件抛出异常，例如提取器 bug，或深度嵌套的生成代码导致栈溢出。
- **原影响**：
  - 全量构建不写 `file` 行，于是 contentManifestId 与 tracker 不一致。
  - 增量构建把没有行的文件每次都视为 changed，parseChanged 随后 rethrow，整个 job 失败。
  - 失败后 1s 重试，永久循环；该 workspace 之后的编辑全部无法发布。
- **修复**：
  1. 读到字节之后的解析/提取异常，统一返回 `parseState=FAILED`、带 contentHash 的空 bundle。全量、增量串行、增量 off-thread 三条路径共用这一处逻辑。错误信息放在 `bundle.parseFailure`，不入库。
  2. 提取器中按 AST 深度递归的四个遍历（`visitCompilationUnit`、`collectCallSites`、`visitLocalTypeDeclarations`、`countErrorNodes`）改为显式栈。
     - 任务顺序与递归版完全一致：前序遍历、子节点从左到右、declarator 先登记 scope 再处理初始化表达式。因此正常文件的输出不变，不需要提升 facts revision。
     - 改动原因：栈溢出发生在多深的位置取决于线程栈大小（主线程约 1 MB，worker 4 MB）。同一文件可能在全量构建中 FAILED、在 off-thread delta 中 COMPLETE，造成 full 与 delta 静默不一致。改为迭代后结果与线程无关。
- **剩余**：
  - resolve、edge、search 阶段若因内容确定性抛错，仍会让 job 失败。现在有 F2 的退避兜底，但根因未处理（第 1 轮 P3-6）。
  - `extractType`（类型嵌套）和 `buildTypeRef`（泛型嵌套）仍是递归，深度取决于类型和泛型的嵌套层数，实际代码中有界。
  - delta 路径中 `bundle.parseFailure` 没有回传通道（builder 结果协议里没有诊断字段），只能从 `file.parse_state=FAILED` 看出。

### F2（P2）失败与清单分歧没有退避

- **位置**：`index-owner.ts` WorkspaceIndex，`workspace-tracker.ts`（workMark）。
- **原影响**：
  - 持续性失败每 1s 重试，反复占用唯一的 full 槽。
  - 持续性清单分歧以 25ms 间隔热循环"发布 → seal → 校验 → 全量 hash"。
- **修复**：
  - `setbacks` 计数：失败或分歧加一，干净的 round 清零。
  - 失败重试间隔为 1s 倍增，上限 5min。首次分歧立即重试，连续分歧才退避。
  - tracker 新增 `workMark`：单调计数，跨 stream 重启不重置，每次真正产生待办时加一。round 在 dispatch 时记录当时的 workMark。
  - 退避期间，只有 workMark 前进（新的待办，可能正是修复）才能把等待缩短到 ≤1s。target/、IDE 文件的写入不会缩短等待。
  - `kick()` 改为"最早到期者生效"。prepare 在退避期间返回 `backoff`。`status()` 新增 `setbacks` 和 `retryInMs`。

### F3（P2）大小写不同的重命名留下幽灵文件（大小写不敏感的 APFS）

- **位置**：`workspace-tracker.ts` verify，paths 模式。
- **修复**：
  - 对不是来自 readdir 的路径（pending 路径和 subtree 前缀），逐级用父目录列表确认名字精确存在。
    - NFC 归一化后相等视为同名，此时以 readdir 给出的拼写作为 census key，与 full walk 一致（第 3 轮 P3-3）；大小写不折叠。
    - 目录无法列出时退回原来的 lstat 判定。
  - 名字不精确存在但 lstat 能打开时：
    - 移除提示拼写下的成员；
    - 先清空本次 verify 的目录列表缓存并重列一次。若列表早于 safe-save 的 rename，此时名字已能精确命中（第 3 轮 P3-2）。大小写敏感卷上能打开就一定精确存在，所以不会进入下一步的大小写折叠。
    - 重列会清空整个缓存。`eachLimited` 并发时，其他任务可能因此多做几次 readdir，但结果正确，只影响开销。
    - 仍未命中时，逐级做大小写不敏感匹配（每级须唯一），找到 readdir 给出的真实拼写，本轮直接读取（不使用 stat 缓存）；subtree 则重新遍历。不会先发布一次"删除"再加回来（第 2 轮 P3-3）。
    - 无法唯一确定拼写时，在 cut 之后登记一次 full-stat，由下一轮 walk 找回，避免静默缺失（第 1 轮 P3-5）。

### F4（P2）改 pom 就全量重建

- **事实依据**：提取器不读构建文件；layout probe 只读标记文件是否存在和根 pom 的 `<module>`；name-resolver 不建模模块间依赖。
- **约束**（第一版方案被 review 否决的原因）：
  - `buildKeyChanged` 是 pom 变更通知 JDT 和 router 的唯一通道（`repo-runtime-manager.ts` changeBatchFor）。
  - owner 在 buildKey 变化时强制 full，同时也是防止 tree-sitter 升级后在旧 facts 上做 delta 的唯一保护。`compatibleDeltaBase` 不检查提取器版本。
  - 因此 buildKey 必须保留构建文件内容。
- **修复**（buildKey 和事件语义不变）：
  - 全量构建额外在 meta 中记录 `layoutFingerprint`（去掉 `build:*` 条目的布局指纹）和 `extractorVersion`。两个指纹由 `computeInputFingerprints` 一次遍历算出，tracker、cold-build、incremental 共用。
  - tracker 在每个 round 上记录 `layoutFingerprint`。
  - buildKey 变化、没有 seed、且使用自身 base 时，owner 在 clone 之前通过新的 query op `buildInputs` 读取 base 记录的两个值，以及 base 的 schema、identity、facts 版本是否与当前一致（`schemaVersionsMatch`，即 `compatibleDeltaBase` 中的同一检查；`extractorVersion` 字符串不含 `SCHEMA_VERSION` 和 `STABLE_ID_VERSION`，第 3 轮 P3-1）：
    - 三者都一致 → 发 rescan delta，并标记 `buildInputsMoved`；
    - 任一不一致或缺失 → 直接在空 job 上 full，fullReason 仍为 `build-key-changed`，不付 clone、预热、delta 槽的代价（第 2 轮 P3-1）。
  - builder 看到标记后用同样的条件再核对一次（兜底），通过才写入新的 `buildFingerprint` 并按 delta 执行；否则升级为 full（`builder-inputs-changed`）。
  - 新快照携带新 buildKey，publish 事件中 `buildKeyChanged=true`，JDT 和 router 照常收到 BUILD_CHANGE。
- **兼容**：旧快照没有这两个 meta，首次遇到 pom 变化时由 owner 直接判为 full，之后正常。`LOGICAL_META_KEYS` 不含新 key，logicalDigest 不受影响。query op 是新增的，owner 与 query worker 同进程版本发布，没有混合版本问题。
- **测试**：
  - 新增 `incremental.test.ts`："a build-file-only change is a delta …"（未标记时升级；标记后走 delta；提取器版本不符时升级）。
  - 修改 `owner-seed.test.ts`：
    - 原来的 "explicit full … never a rescan delta" 改为 "… rescan delta on its own base"。这是一次有意的合同变更。
    - 新增 "… build inputs moved its layout gets an explicit full …"：新增 `src/test/java` 并改 pom → `["full","full"]`、无 clone、fullReason 为 `build-key-changed`。
    - "a builder that reads a later build key is refused …" 的最后一轮由 `full` 改为断言 `rescan` + `buildInputsMoved`（第 2 轮 P2-1）。

### F5（P2）大 diff（切分支）只能全量重建

- **位置**：`index-owner.ts` runRound/supersede，`snapshot-store.ts`。
- **修复**：
  - **保留时机**：只有切换相对自身 binding 的 diff 超过 `DELTA_CLOSURE_LIMIT` 时，切换前的快照才作为该 workspace 的保留 seed，保留在它自己的 buildKey 下。两个分支的构建文件不同也同样保留（第 2 轮 P3-2）。普通编辑替换下来的快照仍然像原来一样立即回收。超过上限的批量格式化也会被当作"切换"，代价是多保留一个快照。
  - **保留规则**：每个 workspace 保留 1 个，全局上限 `MAX_RETAINED_SEEDS=4`，只在内存中，重启后的首次 sweep 会正常回收。tryReclaim 对保留中的快照返回 `retained`；保留中的快照一旦校验 FAILED 就不再保留。
  - **seed 候选**：`seedCandidates` 先列保留 seed（最新的在前，排除自己当前绑定的快照），再列兄弟 binding。
  - **owner 判定**：自身 diff 超过上限（且没有 fullNext）时也评估 seed，只有 seed diff 更小时才采用，可能走 seed-bind 或基于 seed 的 delta。
- **成本**：每个 workspace 最多多占一个快照的磁盘，可由 F6 释放。

### F6（P3）没有磁盘保护

- **修复**：创建 job 前检查缓存卷的 `statfs` 可用空间。
  - 低于 `MIN_FREE_BYTES`（512 MiB，`minFreeBytes` 可配置，0 表示关闭）时，先释放所有保留 seed 并回收。
  - 仍然不足时，本轮以 `insufficient disk space` 失败，进入 F2 的退避。
  - fullNext 在检查通过后才清除。
- **说明**：APFS 的 f_bavail 不含 purgeable 空间，所以下限取得较低。它只用于阻止在几乎写满的卷上启动构建，不是容量估算。

### F7（P3）FRESH 标签缺少 fence

- **修复**：`prepare` 在 tracker 为 FRESH 且没有 round 时，先执行 `tracker.flush()`（FSEventStreamFlushSync），再冻结标签。
  - 若 `waitFor` 返回 `covered`，在给出 FRESH 前再 flush 一次。
  - 等待受 prepare cap 约束。并发请求共享 fence；后到的请求等待下一次 fence。
  - 请求最多等 fence 200 ms（`REQUEST_FENCE_WAIT_MS`，且不超过 cap）。正常的 fence 几毫秒返回；超出时 fence 在后台继续，由后续请求共享，本请求按已有标签回答，与没有 fence 时的行为一致（第 2 轮 P3-5）。
  - fence 本身的超时为 30s。fence 超时会杀掉 helper，所以请求路径不能比 dispatch 的 5s 更激进；真正卡死的 helper 仍由下一次 dispatch 发现（第 1 轮 P3-2）。

### F8（P3）每次 clone 都对 Node 可执行文件做 SHA-256

- **修复**：`readMacNativeIdentity` 按目录缓存校验结果，缓存键为 manifest、helper、node 三个文件的 `dev/ino/size/mtimeNs/ctimeNs`。只有校验前后 stat 不变时才写入缓存。

### F9（P3）tracker 的 stat 缓存只增不减

- **修复**：full walk 结束后，删除不在本次清单中的缓存项；路径消失时同步删除对应缓存。

### F10（P3）后台校验在持续编辑下可能永远不完成

- **修复**：
  - 防抖等待不超过最早一次 enqueue 之后的 60s。
  - 连续 3 次 superseded 中止后，让当前校验跑完。它的结论仍作用于血缘。
  - 非中止的错误也会重置中止计数。

## 未修改或已撤回（附理由）

- **清单分歧后强制全量 hash（原 P3）**：曾改为只重读分歧路径，已撤回。
  - `owner-seed.test.ts:457` 的合同明确规定：分歧说明存在没有事件的变化，两边都没看到的成员只有全量 hash 才能发现。
  - 持续分歧的代价已由 F2 的退避控制。
- **长 delta 血缘的空闲页（原 P3，假设）**：曾在 builder 中加入 `incremental_vacuum`，已撤回。
  - 在 CoW clone 上搬页会让 clone 与 base 不再共享这些块，WAL 也会临时增长，而且时间计入 delta 的截止时间。
  - SQLite 会复用空闲页，膨胀是否真实存在没有测量。先测量再决定。
- **根目录 st_dev 变化导致全量重建**：根治需要改用 APFS 卷 UUID，并迁移所有 workspaceId，推迟。
  - 曾尝试"回收根已不在的 binding 时保留其快照"，但它违反 GC 合同（`snapshot-store.test.ts:575`、`owner-gc.test.ts:147`），已撤回。
- **闲置 worktree 回收默认 observe**：属于用户策略，不改默认值。
- **`nameDependentPaths` 的文本启发式**：判定方向是过度包含，不会漏。建议补充随机编辑序列的差分测试。
- **tracker 与 builder 两套清单实现**：建议补不变量测试（符号链接、忽略目录、大小写重名、不可读文件、解析异常）。
- **测试缺口（第 3 轮 P3-4）**：
  - F3 没有测试。它需要大小写不敏感的卷（macOS 默认 APFS），建议在 `workspace-tracker.test.ts` 中补三类用例：只改大小写的文件重命名、只改大小写的目录重命名、无法唯一确定拼写时登记 full-stat。
  - F4 缺两类测试：没有新 meta 的旧快照遇到 pom 变化时直接 full（sealed 快照不可变，需要一个预置旧格式快照的 fixture）；`buildInputs` 查询失败时该轮失败并退避。
- **测试中的磁盘下限**：owner 测试没有设置 `minFreeBytes: 0`。测试机临时卷剩余空间不足 512 MiB 时会以 `insufficient disk space` 失败；这些测试本来就要跑真实构建，没有为此放宽。

## review 记录

### 第 1 轮（独立 Opus 子代理，只读）

| 发现 | 处置 |
|---|---|
| P1-1：F4 切断了 pom 变更到 JDT 和 router 的通知 | 已重做 F4（见上） |
| P2-1：F7 放松了"分歧即全量 hash"的合同 | 已撤回 |
| P2-2：栈溢出结果依赖线程 | 提取器改为迭代（F1） |
| P3-1：workSeq 跨 epoch 不可比 | 改为单调的 workMark |
| P3-2：请求路径的 fence 超时会杀掉 helper | 请求侧超时改为 30s |
| P3-3：等待 covered 之后没有 fence | 增加第二次 flush |
| P3-4：分歧对账中的 await 窗口 | 随 F7 撤回，不再存在 |
| P3-5：大小写修复可能造成静默缺失 | 改为登记 full-stat |
| P3-6：resolve/edge 阶段的异常 | 记为剩余项 |
| P3-7：incremental_vacuum 的代价 | 已撤回 |
| P3-8：磁盘下限过高 | 降为 512 MiB 并说明 |
| F10 小瑕疵：非中止错误不重置计数 | 已修 |

### 第 2 轮（独立 Opus 子代理，只读）

结论：没有 P0/P1，第 1 轮的处置均成立。

| 发现 | 处置 |
|---|---|
| P2-1：`owner-seed.test.ts` 的 build key 竞争测试仍断言 `full` | 改为断言 `rescan` + `buildInputsMoved` |
| P3-1：layout 或 extractor 变化时先 clone、预热再升级为 full | owner 在 clone 前通过 `buildInputs` 判定 |
| P3-2：构建文件不同的分支切换不保留 seed | 去掉 `!keyChanged` 条件 |
| P3-3：respelled 先发布一次删除 | 本轮按 listing 找到真实拼写并读取 |
| P3-4：`visitCompilationUnit` 仍递归 | 改为显式栈 |
| P3-5：卡住的 helper 会让每个 FRESH 请求等满 cap | 请求最多等 200 ms |
| P3-6：测试中磁盘下限默认启用 | 未改，见"未修改" |
| P3-7：`build-key-changed` 不再产生 | 已恢复（owner 侧判定为 full 时使用） |
| P3-7：两遍 `computeBuildFingerprintEntries` | 合并为 `computeInputFingerprints` |
| P3-7：注释引用了不存在的常量 | 已修 |
| P3-7：delta 路径没有 parseFailure 诊断 | 记为剩余项 |

### 第 3 轮（独立 Opus 子代理，只读）

结论：没有 P0、P1、P2，第 2 轮的处置均成立；读代码没有发现会失败的测试。

| 发现 | 处置 |
|---|---|
| P3-1：owner 预判不比较 schema/identity 版本，只升级这两个版本时仍先 clone 再升级 | `buildInputs` 增加 `schemaCompatible`，owner 一并比较 |
| P3-2：目录列表早于 lstat，safe-save 窗口内会多一次删除；大小写敏感卷上可能折叠到兄弟文件 | 未命中时重列一次再判断；重列后仍未命中才折叠 |
| P3-3：NFC 等价的拼写按提示拼写入库，可能与 full walk 的 key 不一致 | 改用 readdir 的拼写作为 key |
| P3-4：F3、F4 测试缺口 | 记入"未修改" |

## 待决事项与决定（2026-11-11，advisor 裁定）

**合入 main 的门槛**（两项都必须满足）：
1. 在 Mac 上 `npm run build:isolated` 通过，"验证状态"一节列出的四组测试全部通过。
2. 补上 F3 的 tracker 测试：只改大小写的文件重命名、只改大小写的目录重命名、拼写无法唯一确定时登记 full-stat。F3 改了三轮，是本分支最复杂的逻辑，目前没有任何测试。

| 事项 | 决定 | 是否阻塞合入 |
|---|---|---|
| 第 4 轮独立 review | 不做。第 3 轮只剩 P3，剩余风险在编译和测试，review 替代不了 | 否 |
| Mac 上编译和测试 | 必须通过 | **是** |
| F3 测试 | 合入前补上 | **是** |
| F4 旧快照、`buildInputs` 查询失败的测试 | 开后续 issue。失败方向是 full 或退避，属于安全方向 | 否 |
| resolve/edge 阶段由内容引发的异常 | 后续处理，目前有退避兜底 | 否 |
| delta 路径没有 parseFailure 诊断 | 后续处理，需要改 builder 的结果协议 | 否 |
| st_dev 改用卷 UUID | 维持推迟 | 否 |
| 测试中 512 MiB 的磁盘下限 | 不改。本地 Mac 上真因此失败时，再在 `openOwner` 里设 `minFreeBytes: 0` | 否 |
| 批量格式化被当作"切换"，多保留一个快照 | 接受。每个 workspace 最多 1 个、全局最多 4 个，F6 可以释放 | 否 |
| 闲置 worktree 回收默认为 observe | 不改，属于用户策略 | 否 |
