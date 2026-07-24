# codex-java-lsp-mcp 深度架构审查与阶段性优化改造方案

> 基于源码版本 `codex-java-lsp-mcp`、已有 benchmark / readPlan / semantic gap / warm latency 文档进行分析。
>
> 目标：将当前“低 token Java 语义导航 MCP”演进为面向 AI Coding Agent 的高精度、低延迟、可扩展 Java 代码理解基础设施。

---

# 1. 总体评价

## 当前定位

项目当前不是传统 Java LSP wrapper，而是：

```
Codex Agent
    |
    MCP Tools
    |
Impact Router
    |
+----------------+
| SourceIndex    |  冷路径事实层
| rg search      |
| Ranking Engine |
+----------------+
        |
        v
+----------------+
| JDT LS         |  语义增强层
| Symbol         |
| References    |
| Diagnostics    |
+----------------+
```

整体方向正确：

- SourceIndex 作为 cheap fact layer
- JDT LS 作为 expensive semantic layer
- impact/readPlan 作为 Agent 上下文压缩入口

这是比“直接暴露 LSP API”更适合 AI Agent 的架构。

---

# 2. 当前最大瓶颈判断

## 2.1 语义模型不足

当前 SourceIndex 主要保存：

- 文件事实
- 类型
- annotation
- extends/implements
- referencedTypes
- methods

但是对于大型 Java 项目：

真正影响修改范围的不是文件，而是：

```
Class
 |
Method
 |
Call Graph
 |
Dependency Graph
 |
Data Flow
 |
Transaction Boundary
 |
API Exposure
```

目前缺少：

- method call graph
- bean dependency graph
- controller -> service -> repository chain
- event publisher/subscriber graph
- database mapper relationship
- configuration injection graph


优化方向：

引入 Java Semantic Graph。

例如：

```
                UserController
                      |
                      v
                UserService
                 /        \
                v          v
          UserRepository   CacheService
                |
                v
             UserEntity
```

Agent 查询 impact 时直接得到影响子图。

---

# 3. 第一阶段优化（基础索引升级）

目标：

降低 cold path 延迟，提高 recall。

周期：2-4 周。

---

## 3.1 SourceIndex 从文件索引升级为 Repository Semantic Index


新增：

```
semantic-index/

 files
 types
 methods
 annotations
 imports
 inheritance
 call_edges
 bean_edges
 api_edges
```

推荐存储：

SQLite / DuckDB。

原因：

当前 JSONL：

优点：
- 简单

缺点：
- 查询复杂关系困难
- 无法做 graph traversal


推荐：

SQLite:

```
type_node

id
name
package
kind


method_node

id
type_id
name
signature


edge

from
to
edge_type
confidence
```

---

## 3.2 增量索引

当前：

mtime + size 判断。

升级：

Git aware incremental indexing。


利用：

```
git diff --name-only HEAD
```

只重新解析：

```
modified java files
affected dependency files
```

目标：

百万行 Java 项目：

首次：

10min

↓

增量：

<5s


---

# 4. 第二阶段优化（Ranking Engine）

当前 ranking 已经有：

- stereotype
- package proximity
- type relation


但是仍属于 heuristic。


升级为：

## Hybrid Ranking


```
Candidate Score

=
Static Signals
+
Graph Distance
+
Historical Feedback
+
LLM Feedback
```

---

## 新 Signal

### 1. Architecture distance

例如：

Controller 修改：

优先：

```
Controller
Service
DTO
Validator
Repository
```

降低：

```
common
utils
config
```

---

### 2. Runtime importance

结合：

- API exposure
- transaction
- scheduled job
- event


例如：

@Transactional 方法：

权重提升。


---

### 3. Change propagation


计算：

```
affected files

=

reverse dependency graph
```

而不是简单搜索。


---

# 5. 第三阶段优化（JDT LS 管理）

当前设计：

JDT LS bounded startup。

方向正确。


进一步：

## 5.1 Persistent LSP Pool


现在：

repo -> session


升级：

```
JDTLS Manager

        |
 -----------------
 |       |        |
repoA  repoB   repoC
```

能力：

- idle eviction
- memory pressure control
- preload


---

## 5.2 Lazy Semantic Activation


不要：

启动 LSP 后等待。


改成：

```
impact request

 |
 |-- source index

 |
 need semantic?

 |
 yes

 |
 start JDT
 |
 query exact symbol
```


---

# 6. 第四阶段优化（AI Agent Context Engine）

这是未来价值最高部分。

当前输出：

readPlan。


升级：

Context Planning Engine。


输出：

```
Task Context Package

{
 files,
 symbols,
 dependency,
 risk,
 test_points,
 migration_hint
}
```


例如：

用户：

> 修改订单退款逻辑


自动生成：

```
核心修改:

OrderRefundService


必须检查:

OrderController
RefundRepository
PaymentClient


风险:

@Transactional boundary


测试:

RefundServiceTest
PaymentMockTest
```

---

# 7. 第五阶段（Feedback Learning）

目前 ranking 是人工规则。


未来应该闭环：

```
Agent Action

 |
 修改文件

 |
 Git diff

 |
 判断推荐是否命中

 |
 更新 ranking weight
```


形成：

Java Code Intelligence RL。


---

# 8. 性能目标


|指标|当前目标|未来目标|
|-|-|-|
|cold impact|秒级|<500ms|
|warm impact|秒级|<100ms|
|百万行项目索引|分钟|首次<3分钟|
|增量更新|秒级|<5秒|
|symbol recall|提升|95%+|
|无效上下文|降低|50%+|

---

# 9. 推荐演进路线


## Phase 0

完成：

- benchmark 固化
- tracing
- metrics


## Phase 1

SourceIndex 2.0

重点：

SQLite semantic index


## Phase 2

Graph Engine

重点：

dependency graph


## Phase 3

Ranking v2

重点：

hybrid ranking


## Phase 4

Context Engine

重点：

Agent workspace intelligence


## Phase 5

Learning System

重点：

feedback loop


---

# 10. 最终架构目标


```
                 AI Agent

                    |
                    v

             Context Engine

                    |
          ---------------------

          Semantic Graph

          Ranking Engine

          Source Index

          LSP Semantic Layer


          ---------------------

                    |
              Java Repository
```


# 结论

当前项目方向正确，最大的价值不是成为“更快的 LSP”，而是成为：

> 面向 AI Coding Agent 的 Java Repository Intelligence Engine。

短期优化重点：

1. SourceIndex 图化
2. 增量索引
3. Ranking 信号增强
4. LSP 生命周期优化

长期：

构建 Java 代码知识图谱 + Agent Context Planning。

这会比简单优化 LSP 调用获得数量级收益。
