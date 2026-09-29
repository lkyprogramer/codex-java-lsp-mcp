# T11 报告：按残余缺口加深 Java 绑定 — NOT_NEEDED

**里程碑：** M3-conditional
**结论：** `NOT_NEEDED` — M2 实测的残余失败中没有可复现的 overload / generic / dispatch 绑定缺陷；按任务卡步骤 5（"无重复绑定缺陷时记录 NOT_NEEDED 并跳过，属于合理完成"），不启动 `call-resolver` / SemanticGateway / SCIP 分支。

## 触发检查（任务卡步骤 1：先排除入口/范围错误）

### 1. M2 实测失败盘点（LIVE 全矩阵，24 dev × 2 臂 × 3 repeat = 144 runs，全部 MEASURED）

results pack：`/Users/luo/Documents/github/java-devkit-v1-runs/m2/live-full/results-pack.json`（sha256 `a36a0190f0d69be6…`）。

| 任务 | product | control | 失败类别 |
|---|---|---|---|
| JSB-PETCLINIC-01/02 | 3/3 | 3/3 | —（两臂都过） |
| JSB-MYBATIS-02 | 3/3 | 3/3 | —（两臂都过） |
| JSB-GSON-03 | 3/3 | 0/3 | 模型能力（见下） |
| 其余 19 个任务 | 0/3 | 0/3 | 词法发现缺口 + 模型能力混合 |

### 2. 失败运行的 SOURCE_RECEIVED 交叉验证（决定性证据）

对失败任务抽查 `source-received.jsonl`（3,321 条 SOURCE_RECEIVED 事件）：agent **已经读到了 gold 证据文件**，产出的是键名完全正确、值错误的结构化答案：

| 任务 | gold 答案 | 失败运行实际答案 | 失败类别 |
|---|---|---|---|
| PAYMENTS-01 | method=`accept` | 读到 PaymentService.java 后答 `isDuplicate` | 模型能力（读对文件、取错事实） |
| INVENTORY-01 | true/true | 读到 StockService.java 后答 false/false | 模型能力 |
| ACCESS-01 | method=`isAllowed` | 读到 SignedAccessPolicy.java 后答 `checkTemporaryAccess` | 模型能力 |
| GSON-01 | result=`a_U_R_L` | 读到 FieldNamingPolicy.java 后答 `a_URL` | 模型能力 |
| PETCLINIC-03 | `isAssignableFrom` | 读到 PetValidator 后答 "exact class equality" | 模型能力 |
| PAYMENTS-03 / PRICING-03（repair） | gold=null（P 轨） | 模型自述 "java_symbol 未定位" 但 repair 无 tester → UNMEASURED | 词法缺口（发现层，T10 覆盖） |

**没有任何一条失败运行呈现绑定缺陷的签名**：没有"解析到错误 overload 的签名"、没有"generic 类型参数解析错误"、没有"dispatch 到错误实现"。失败答案全部是"对的文件、对的结构、错的事实值"——这是 27B 开放权重后端的推理/抽取能力问题，不是静态绑定层的缺陷。

### 3. M3 检索层对照（排除发现层被误归因为绑定层）

`/Users/luo/Documents/github/java-devkit-v1-runs/m3/retrieval-comparison/results-pack.json`：A2（纯词法）micro recall 0.694，A3（+dense 提示）0.778。残余缺口集中在**跨语言词法不可达**（中文 query vs 英文代码 token），即发现层问题——由 T10 的外部 dense 提示路由，与调用绑定无关。

### 4. 为什么这些任务用不到绑定机制

M3 评测任务的 gold 全部是"声明定位 + 事实抽取"型（QA）或 P 轨修复（UNMEASURED）。没有任务的 gold 要求"overload 消解后的运行时唯一实现"，`java_impact` 调用图链在这些任务上从未被 gold 消费。K22–K24/K28 的运行态项（真实 JDT 绑定）**未执行**：无重复绑定缺陷触发，且 JDT 在本里程碑保持 `JDT_BIN=/usr/bin/false` 静态纪律。

## 未测项（如实列出）

- K22/K23/K24/K28 运行态绑定契约：**NOT_RUN**（无触发失败；列入 M3 未执行清单）
- repair（P 轨）任务在绑定层的表现：UNMEASURED（无 repairTester 注入；与 M2 一致）
- 强模型后端下的绑定缺口：本里程碑 27B 后端的模型能力失败可能掩盖了少量真实绑定缺口；若 M3 后续用强模型重测仍出现"候选签名与 gold 签名不一致"的失败，需重新评估本结论

## 产物

- 未修改 `src/java-knowledge/call-resolver.ts`、framework facts、SemanticGateway：现有静态绑定已是任务卡要求的保守行为（"无指针分析；歧义 overload 不发射边"——`call-resolver.ts` N2a-01 注释与实现一致），且实测失败签名不指向该路径，无对象可修
- 无新依赖、无产品代码变更（本卡零 diff 完成，属文档结论任务）
- 证据全部来自已冻结的 M2 results pack 与 M3 检索对比（hash 见上）