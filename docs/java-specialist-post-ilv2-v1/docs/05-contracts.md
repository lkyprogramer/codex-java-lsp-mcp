# 05 接口、身份与错误合同（拟新增部分）

本章是实施规范，不声称当前分支已经支持outline或扩展evidence。原有ILV2身份和状态类型继续从项目导入，不复制第二份定义。Q00检查当前HEAD后，新增模块按下列名字实现；若已存在同功能，复用并记录映射。

## 5.1 公共工具面

仍是java_status、java_symbol、java_impact、java_diagnostics、java_runtime。

```json
{"operation":"outline","repoRoot":"/authorized/worktree","file":"src/main/java/example/OrderService.java","limit":8}
```

`outline`只接受file、可选nearLine/limit/detail以及root/alias；query/terms/symbolId/backend=jdt与outline组合拒绝。file使用现有containment与owner解析。limit 1..20，默认8；超出拒绝不silent clamp。nearLine为正的一基行号。sourceSet/module是query过滤器，不对单文件outline偷偷上溯切仓。

`symbolNeedsJdt()`对outline和evidence恒false；注册层和handler使用同一判定。无LSP enablement时仍可静态使用；没有可服务索引则返回明确NOT_READY。

## 5.2 内部outline纯函数

文件：拟新增`src/discovery/outline.ts`。

```ts
export interface OutlineEntryInput {
  declarationKey: string;
  kind: "type" | "method" | "constructor";
  name: string;
  signature: string;
  startLine: number;
  endLine: number;
  selection: { line: number; column: number };
}
export function selectOutlineEntries(
  entries: readonly OutlineEntryInput[],
  options: { limit: number; nearLine?: number }
): { entries: OutlineEntryInput[]; omittedSymbols: number };
```

去重以declarationKey，不以名称；包含nearLine的最小跨度声明优先，然后源码顺序，最终稳定tie-break为declarationKey。超长签名不截成伪造源码：公开层省略signature并给`signatureOmitted=true`，名称/selection/identity保留；仍放不下时整条省略。选择器不读取文件、不执行SQL、不生成新ID。

```ts
export async function runOutline(
  client: JavaIndexClientApi,
  input: {
    repoRoot: string; file: string; limit?: number;
    nearLine?: number; budget?: DeadlineBudget;
  }
): Promise<OutlineInternalResult>;
```

`OutlineInternalResult`定义在同文件：schemaVersion=`java-outline/v1`、generation、relativePath、contentHash、entries、omittedSymbols、scopeState READY|PARTIAL|NOT_READY、reasons。entries在内部包含declarationKey；工具层复用`declarationIdentities`/`formatSymbolId`的单一映射，wire上去掉declarationKey，输出stability以及symbolId或已有evidenceHandle，附现有indexView。

wire总预算4096字节包括indexView。最小错误信封本身超预算时返回已有结构化错误，不截断JSON或丢身份字段。不是对所有schema/工具的全局4096限制。

## 5.3 Evidence fragment v2

继续`java_symbol operation=evidence`，输入现有symbolId或file/line/column。API升级为`schemaVersion=java-evidence-unit/v2`，supportedScope=`java-declaration-and-indexed-resource-links`，不写兼容双返回。

```ts
export type EvidenceProof = "SOURCE_FACT" | "STATIC_CANDIDATE" | "JDT_BOUND";
export type EvidenceRole = "anchor" | "signature" | "callsite" | "definition" | "resource";
export interface EvidenceFragment {
  path: string;
  contentHash: string;
  startLine: number;
  endLine: number;
  text: string;
  role: EvidenceRole;
  proof: EvidenceProof;
  complete: boolean; // 选定的目标范围是否全交付，不表示全仓分析完整
  originalEndLine?: number;
}
```

`JDT_BOUND`只由真实JDT结果投影生成，并记录诊断侧toolchain/classpath身份；Q04只生成SOURCE_FACT，Q05允许STATIC_CANDIDATE，不能无条件晋级。读出源码本身是真实的，不意味着源码中一次方法调用的目标已经精确绑定。

一基行范围两端包含；column一基UTF-16（与现有locator相同）；内部转换LSP零基半开区间只在统一转换函数处理。UTF-8字节预算用实际编码；CRLF保留。不得通过`.trim()`或换行归一化生成“原始源码”。

同文件多unit计费按实际输出bytes；质量覆盖对同hash范围取并集，重复输出不会提高coverage。跨hash同路径不能合并。

## 5.4 统一有界源读取

拟新增`src/discovery/evidence-source-reader.ts`，从现有readSource提取，不写第二套安全实现。

```ts
export async function readVerifiedEvidenceFile(input: {
  root: string; relativePath: string; expectedHash: string;
  maxFileBytes: number; budget?: DeadlineBudget;
}): Promise<{ bytes: Uint8Array; text: string; contentHash: string }>;
```

路径必须canonical包含于root，文件为普通文件，link检查/打开后stat/末次路径与hash按现有约束执行。返回不可变意义的本次读取数据；错误使用稳定原因。Q04不改变两次anchor检查；Q09若做请求内去重，需单独证明异步读期间变更仍正确拒绝。

## 5.5 局部关系（仅Q05触发时）

拟新增`src/discovery/local-relations.ts`，消费现有准确目标查询，不暴露任意图DSL。

```ts
export interface LocalRelationRequest {
  declarationKey: string;
  direction: "callers" | "callees";
  maxTargets: number; // 首版固定上限8，非每个hop重置
}
export interface LocalRelationProjection {
  sites: Array<{
    sourcePath: string; sourceHash: string;
    startLine: number; endLine: number;
    targetKeys: string[];
    proof: EvidenceProof;
  }>;
  completion: "COMPLETE" | "PARTIAL";
  reasons: string[];
}
export function projectLocalRelations(
  references: readonly IndexedReference[],
  request: LocalRelationRequest
): LocalRelationProjection;
```

该签名是设计；实际`IndexedReference`缺失的sourceHash/targetKeys必须从同held快照事实补齐，不推断不存在的字段。补不齐标PARTIAL并保留已知位置，不invent绑定。公共结果通过已有mac1身份投影。

## 5.6 最终消息凭据

Q01在**最终请求序列化以后**捕获body。每条source receipt引用tool_call_id、messageIndex、该message内的textPointer、path/hash/行范围、workspaceId/contentManifestId和requestBodySha256。计划range/候选名不产生receipt。

包内`tools/check_delivery.py`是此边界的参考检查器：证明所提供的request body包含对应源码；不证明请求已经被模型服务接收、模型确实使用了它或任务成功。真实LIVE还须记录HTTP/宿主完成状态和provider原始usage。不能自造“已读/已理解”指标。

## 5.7 结果状态

业务/评测状态分开：

- 工具：READY / PARTIAL / NOT_READY；另记truncated/omitted与binding证据。
- 任务执行：COMPLETED / FAILED / TIMED_OUT / NOT_RUN / BLOCKED_ENV。
- 验收：PASS / FAIL / INCONCLUSIVE / NOT_TRIGGERED。
- 发布：ENGINEERING_ELIGIBLE不等于BENEFIT_MEASURED，也不等于DEPLOY_AUTHORIZED。

不因测试未运行设置taskSuccess=false后混进已测成功率，也不因FAILED就从已调度分母移除。报告同时给scheduled、attempted、completed、successful与missing数量。
