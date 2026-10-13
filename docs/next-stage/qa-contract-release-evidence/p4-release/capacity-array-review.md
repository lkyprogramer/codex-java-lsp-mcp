# P4 第二局部组合补丁独立评审

结论：**正确性评审 PASS，无具体 findings。性能门仍未判定。** 本报告保留并衔接第一份 `capacity-patch-review.md`，精确基线是已评审的 ADtF8Q；不将旧历史 diff 纳入当前补丁。

读取两文件完整 before/after diff、相关 SQL/cache/budget/snapshot 控制流与本地 Node SQLite 类型声明。当前两文件与隔离 zlPTg7 的对应源文件 SHA-256一致；`capacity-array-tests.log` 记录20/20 PASS、0 skipped、0 failed。本代理没有重新执行测试或benchmark。

## 已核查行为

- **数组模式限于专属posting statement。** `postingStatement` 四处调用仅为entity/doc两路的batch与scoped page。其SELECT投影及WHERE形状未被任何非posting consumer共用；仓库检索该投影只在这两处定义。`pageEnd`、entityIds、实体详情、generation及其他get/iterate继续走普通prepareCached，未调用setReturnArrays。缓存SQL精确匹配，不会把非posting object行改成array。相同posting SQL后续消费者均经postingValue兼容两种行。
- **列位与类型一致。** Entity数组依次为entitySym/tf/len；document为docSym/tf/docLen/declarationSym。所有key、bucket及TF读取位置与SELECT逐列对应；对象分支使用原alias。整数仍经同一asInt处理number/bigint。被删除tokenSym列由当前token循环值传递，SQL仍绑定同一tokenSym等值条件；无跨token归属猜测。
- **扫描停止与资源关闭一致。** 旧generator逐行yield后billPosting，现callback仍在每行首部billPosting；false立即返回scanPostings。Unscoped物化页仍最多256，remaining+stop row保持，examined仍整页计数。Scoped对native iterator使用for…of，在callback false导致函数return或抛错时执行IteratorClose，等价于旧外层break关闭generator再关闭yield*／native iterator。没有手动next留下活跃statement。
- **deadline与计量调用顺序保持。** 每页expiredBefore／scoped budget.expired、每行take、visited、keyset推进及stopReason优先级未变；行消费前失败不计posting。无需读取下一页或下一token即可停止。数组/对象parity比较去掉纯wall时间后仍保留trace阶段、remainingMs、visited、truncated、selectionLimited、generation和work，覆盖max7、mid-batch deadline、scope及无命中。
- **排名及已有合同不变。** JOIN、score计算、whole-tier512 ID解析、localeCompare、doc refill、read snapshot、generation及locator没有修改。旧1025 tie三批、600 missing declarations refill和513 batch/generation测试保留。package engines、driver与query-budget逐文件hash与ADtF8Q和zlPTg7相同。生产src无probeState或FORCE_FALLBACK seam。
- **版本兼容界限明确。** 本地@types/node/sqlite.d.ts将setReturnArrays标记since22.16，并说明all/get/iterate均支持array行。typeof方法存在才调用true；不存在时保持原native object输出。新增测试在同运行时对statement instance屏蔽该方法，验证object与array两条表示的完整结果一致；它不是旧Node版本实机证明。旧Node本轮未运行，未宣称其所有运行时行为均获实测。

## 验证与性能声明边界

本代理实际执行：只读diff、定向源码检索/阅读、日志阅读及文件hash校核；只写此MD/JSON。未运行测试、模型、容量benchmark、full suite、JDT、安装、daemon替换。

可继续在zlPTg7候选按原默认worker1与原容量门实测。本报告不以20tests或外部perf probe判原门PASS。父代理提供的80+17 parity及native/lean、native/forced-record小幅耗时差仅是外部helper测量；本评审未核对其raw，也不将JIT/helper混合归因为单一数组优化收益。不改变任何原QA、repair、容量或发布门。

## 文件绑定

- `src/java-index/sql/entity-search.ts`：ADtF8Q `8bbe1b287cf3c8498d8e2d7562e289d16dda1154478f9754efb2edca494b5b40`；current / zlPTg7 `d150191059d2bbd8685628a414e3bb5ccfafdd288ffad5540a37f5f554486dda`。
- `src/java-index/sql/entity-search-bounded.test.ts`：ADtF8Q `d91f5501632bafd3f0e46ec0124706388ae86030ea8b22993dddaa815f387da8`；current / zlPTg7 `fa1f45f0c1315a1b58f9403d666cdcfdd7efa80d23b6b950efb335c111fe74a3`。
