# 增量架构与精确实现约束

## 不变部分

不修改 SQLite 主数据源方向，不恢复每仓常驻全图，不重写为 Java。保留公开五工具。新静态 `java_symbol query` 使用 existing index，不需要 JDT enablement；position/references 与显式 backend=jdt 保持绑定能力。

## 声明身份

FQN 是检索属性，不是仓库唯一主键。具名 ID 建议固定为 `type:v2:<encodeURIComponent(relativePath)>#<encodeURIComponent(fqn)>`。先规范化 repo-relative 路径，拒绝绝对路径、URI、..、空段和 NUL；大小写不擅自折叠。同一文件前插空行不改具名 ID；移动文件改变 ID并重建引用。匿名/局部类型需要 owner+局部范围区分，不能复用具名规则。

方法 ID 沿用 owner declaration ID + erased signature，字段沿用 owner + 字段名。同一路径同声明在 sibling worktree 可产生相同局部 ID，但所有跨库/缓存键必须包含 repoHash/contentHash；不要把本地 ID 宣称全世界唯一。

SCHEMA_VERSION 与 identity metadata 换代，旧 cache 可删除重建；type、method、field、entity、kg_node、kg_edge、persisted semantic edge 全部按新身份检查。不做 dual-ID。

## Discovery 请求

```ts
export type SearchMode = 'auto' | 'exact' | 'text';
export type Backend = 'static' | 'jdt';
export interface DiscoveryQuery {
  query: string;             // 1..512 UTF-16 code units
  terms: string[];           // <=6, each <=64 code units
  searchMode: SearchMode;    // default auto
  limit: number;            // default8, max20
  module?: string;
  sourceSet?: 'main' | 'test';
}
export interface DeclarationLocator {
  id: string;
  name: string;             // explicit; adapter must not parse display labels
  relativePath: string;
  contentHash: string;
  module: string;
  sourceRoot: string;
  kind: 'type' | 'method';
  fqn: string;
  signature: string;
  selection: {line: number; column: number}; // 1-based UTF-16
}
export interface DiscoveryCandidate {
  declaration: DeclarationLocator;
  matchedBy: ('exact'|'identifier'|'comment'|'framework'|'dense')[];
  evidenceRange?: {startLine: number; endLine: number}; // inclusive
  preview?: string;
  previewKind?: 'source'|'summary';
  binding: 'source-declaration'|'ambiguous';
}
export interface DiscoveryResult {
  schemaVersion: 'java-discovery/v1';
  repoHash: string;
  generation: number;
  candidates: DiscoveryCandidate[];
  scopeState: 'READY'|'PARTIAL';
  truncated: boolean;
  stopReason?: 'candidate_budget'|'deadline'|'index_partial';
}
```

这是目标契约，不是声称当前 HEAD 已提供。新增 name/previewKind 是为解决评分适配器猜名称、把摘要当源码的问题。原输出其他细节允许收紧，不要求维持无用兼容层。

## 意图区分

exact 接受整个输入为支持的 class/FQN/owner#method 形式。混合字符串 `OrderService rollback refund` 是 text；类名是范围线索，不是提前返回条件。auto 对复杂未支持签名不得胡乱精确匹配；返回可操作错误或转 text 并清楚标记。exact 匹配多声明且无 scope 时保留歧义集合，不选写入顺序最后一个。

text 分别查询有限 identifier/comment/framework 文档；以 declaration ID 归并。RRF 初值 k=60、同权；它是冻结实验初值，不是最优参数。原始 cosine 与 BM25 不直接相加。结构邻域最多补少量具体相关声明，不加载全图。

## SearchDocument

字段：documentId、declarationId、path、contentHash、representationVersion、sourceKind、inclusive range、normalizedText。首轮仅 signature/comment/framework-key。JavaDoc/路由/statement 的原文保留来源；凭空业务总结不进入默认事实。配置只索引可公开 key，fixture secret 不得进入任何摘要/向量。

writer 在同一个文件更新事务中撤销旧文档、旧 df、旧引用，再发布新 hash 与 generation。query 使用与其读事务一致的 stats；跨 generation 查询结果要么旧一致快照，要么 PARTIAL，而不是混出一个 READY。

## 工作量边界

精确 SQL 独立 point lookup，suffix 不与 exact OR 成全索引扫描。module/source-root filter 前推。每个查询限定 term 数、postings visited、候选对象数与输出；触顶返回 truncated。不能先随意 LIMIT postings 再称 global topK；局部截断就是 partial。同步 DatabaseSync 的长操作不会因 async 包装变成可取消，必要时使用单个有界 query worker，而非每仓全图 worker。

## 范围交付

range 优先级：明确请求 anchor → 证明关系的代码行 → 必要签名/控制条件 → 可选辅助范围。多个命中点先集合后合并，不能按 method ID 去重时丢第二个点。按原始 UTF-8 字节计 cost，按 UTF-16 column 定位，CRLF 不重写后算 bytes。源范围 end-exclusive 转行窗口 inclusive 必须显式处理。

当预算无法包含所有硬 anchor，返回 PARTIAL/BUDGET_TOO_SMALL 和未覆盖信息。测试可以接受诚实失败，不能接受删掉 anchor 后声称完整。输出 provenance 的 JDT_BOUND 与 STATIC_CANDIDATE 分开；静态唯一声明也不等于运行时唯一动态目标。
