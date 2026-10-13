# P4 capacity 局部补丁独立评审

结论：**正确性评审 PASS；无具体 findings。性能门未判定。** 当前两文件与隔离候选 ADtF8Q 对应文件字节一致；已读取 `capacity-patch-tests-r2.log` 的 19/19 PASS、0 skipped，但本评审没有重新运行测试。

## 精确范围与真源

对比 P3 候选 co0Y6G（sourceDigest `5f9c8f2f7d4c12e9ec3e6bbfc1ba26fda973f150e3a1ebe5ac8c257a23d6981b`）与当前两个文件的完整 diff，并追踪 `postingRows`、`billPosting`、`entityIds`、`selectTop`、entity/doc 两条 ranking、`searchDetailed` 与 driver 的读事务/statement cache。本次生产变化仅为 cursor key 复用及 ID lookup 每512参数 `.all`；测试变化为 SQL 检测更新、1025 ID tie 回归、600 missing-document 声明回归。本报告不把其他历史改动纳入补丁。

## 核查结果

- **cursor、scope 与 posting 计费不变。** 两条 source 的 `key` 分别读取原本与 `postingKey` 同值的 `t.entity_sym`／`t.doc_sym`。WHERE、JOIN、主键排序及 scoped pageEnd/page 均未变。非 scoped 页仍最多256行，remaining posting allowance + stop row 不变；每行仍经 `billPosting`。`examined` 仍记录已物化整页，deadline 截断 buffered 页时不会把 examined 错写为仅 billed 行数。
- **完整 tie 与排序不变。** `selectTop` 先取整个 cutoff score tier，再对所有已解析 ID 按原 `localeCompare` 竞争 heap。512只限制单次传输，不截断 tier、不提前取top20。1025 IDs测试断言三批 `[512,512,1]`、与全部 IDs 原locale排序一致、postings1025及selectionLimited，直接覆盖跨批 tie。
- **缺失 ID 与 document refill 不变。** ID 查询保留 `entity JOIN sym`，missing先缓存为undefined；无entity的document declaration不会因sym仍存在而被认作有效。600个ghost跨512边界后仍补足下一score tier中的real-a/real-b。document best-by-declaration、docSym tie、evidence加载均未改。
- **snapshot/cache/generation 不变。** entityIds map仅存于当次RouteContext，并在同一读事务内供路由共用；没有跨请求负缓存。512查询仍经原prepareCached且使用绑定参数，低于32766绑定上限；同statement顺序执行。generation、locators及legacy search()的withReadSnapshot路径不变，下一请求新generation测试保留。新测试验证ID查询处于事务内；它不是并发writer完整实测的替代，本次没有新增该声称。
- **deadline 语义未收紧或放宽。** posting页前、每行take及后续route/finish检查保持原状。旧ID iterator同样没有逐ID budget check；新512 `.all`不额外声称硬实时deadline，仍完成完整tie然后以finish的expired检查标记partial。512批次没有新增中断点，此处为保留原语义，不是新的deadline性能证明。
- **兼容性与测试有效性。** PostingSource为内部type；输出schema、数据库schema、公共API、worker默认值和发布预算均未改。旧测试用FROM检测替代已删除alias，仍命中真实entity posting `.all`，保留256、预算7、mid-batch deadline、examined及generation断言。Reflect.apply仅处理Node sqlite overload包装调用，无削弱断言。

## 验证与决策边界

实际执行：只读精确diff、源码/测试/driver阅读、日志阅读、SHA-256绑定核对；仅写本评审MD与JSON。未运行：测试、模型、benchmark、full suite、JDT、安装或daemon替换。19/19是主代理隔离运行日志中的观察结果，不是本代理重跑结果。

允许进入同原门的容量实测；不能据此宣称性能PASS或发布PASS。主代理提供的补丁前default-worker1容量数值为query212.089／update194.144，本报告未独立复测，不推断补丁收益。原容量门、原QA门、默认worker1与其他发布门须保留。完整tie处理仍与候选数量有关，512只限制单次row transfer；未测收益不等于达到150门。

## 文件绑定

- `src/java-index/sql/entity-search.ts`：before `ea771f2d1f1c30c0556a88e2d3b1e81a63cf8e61479f5920bd4c823be25d7cc3`；current / ADtF8Q `8bbe1b287cf3c8498d8e2d7562e289d16dda1154478f9754efb2edca494b5b40`。
- `src/java-index/sql/entity-search-bounded.test.ts`：before `dac590dc2dd84d086070beaa3ea9045a0accdc88e34ee8c48257d4ed52e6f64d`；current / ADtF8Q `d91f5501632bafd3f0e46ec0124706388ae86030ea8b22993dddaa815f387da8`。
