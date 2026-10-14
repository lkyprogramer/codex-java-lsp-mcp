# MAC-02C / G02C

唯一结果入口：[task-result.json](task-result.json)。主测、独立复验、源码/native身份、实际收尾、归档hash和未覆盖项均由该记录提供。

本轮先验证 ILV2-MAC/4 流程精简，再在同一冻结候选运行 FSEvents 专项。runner 的 `--reuse` 不重建，命令及 fixture 证据各自独占目录；统一收尾先证明真实退出，再归档、物理校验一次并删除到期目录。

真实 OS 溢出未诱发。协议 drop 测试仅证明传输合同。MAC-03B 的 tracker 集成留待该卡，不计入本门。历史 G02B 的 launchd/JDT 证据保留其原候选范围，本轮没有重复该矩阵。

复现入口见[手册 §5.1](../../../deep/codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md#51-当前可用命令与新增-cli-的边界)。本轮候选已按到期清单删除；重现须新建运行根和候选，然后复用新输出的 broker 路径。
