# Autonomous execution contract

本文件约束修改目标 MCP 的 AI，不授权修改验收标准，也不授权网络、付费模型或生产安装。

## 必须保留的产品边界

Java-only、本地优先、只读目标源码、SQLite 为主事实来源、Tree-sitter 为冷结构来源、JDT 为按需精确增强、5 个公开工具。不得恢复 java_context，不建 UI/通用图平台/多语言 registry，不把向量列为默认依赖。

## 开始前

读取 docs/01、02、03、05、06、07、08，随后只读当前任务卡。把源码 SHA、tree/dirty 状态、工具链、数据 manifest hash、执行配置写入外部运行目录。确认当前 checkout 不是在线 immutable release。未知必填版本不得编造。

## 每张卡的状态机

`NOT_STARTED → RED_RECORDED → IMPLEMENTING → TARGETED_GREEN → REGRESSION_CHECKED → REVIEWED → DONE`。

先写真实失败测试；随后修产品而非 gold；记录命令、退出码、日志 hash。一次 commit 只验证一个明确机制。若测试因为缺 JDT/依赖而失败，标 BLOCKED_ENV，不把它算作算法失败或通过。

未达到门禁时最多做两轮有新根因证据的修改；两轮没有净收益则停止该效果分支，输出 INCONCLUSIVE/NO_GO 和最小复现。不以不断加权重或扩大 budget 掩盖问题。

## 可自主修改

当前任务卡列出的产品 src、对应 test、必要 schema 版本、公开接口说明。允许破坏性缓存重建；禁止同时维护新旧事实源。新代码不得读取 benchmark gold、task ID 或 reference patch 作为路由条件。

## 不可自主修改

dataset/corpora、gold、repairs、schemas/gates.json、评分器语义、locked split、实验分母和参考值。若发现真实标签错误，提交 templates/label-challenge.md 所需证据给所有者，先隔离该争议任务并保留原结果；两个实验臂使用同一版本重新运行，不单边修标签。

不运行生产安装脚本，不访问线上端口38456，不外发源码，不下载 embedding 模型，不调用付费 API，不删除既有用户改动。需要这些动作时报告所需授权，继续能离线完成的工作。

## 盲测隔离

开发 AI 只使用 dev 标签；locked 由独立 evaluator 执行。拥有整个 ZIP 的 AI 在技术上可以读答案，因此只能依赖角色权限/挂载隔离；本包不谎称提供强隐藏。一旦看到 locked gold，把当轮 exposure 写进 decision log，并转为 regression。

## 完成报告

必须分别说明：产品 targeted/full 结果；独立 dev/locked 结果；公开 full-corpus 结果；模型任务结果；资源与成本；未运行项；新回归与残余缺口。来源不一样的 PASS 不得合并。交付 git diff/commit、证据目录和下一卡，不写“应该已通过”。
