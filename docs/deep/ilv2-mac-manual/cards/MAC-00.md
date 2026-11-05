# MAC-00 — 冻结runtime、输入和最早成本spike

[索引](../../codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md) · [规则](../rules.md) · [合同](../contract.md) · [验证](../verification.md) · 门状态见 [`status.json`](../../../index-lifecycle-v2/mac/status.json)

**范围：** `docs/index-lifecycle-v2/mac/mac-00/`、历史冻结清单与隔离运行目录；不修旧生产产品。spike允许在临时checkout加测量探针和一次性C clonefile探针，产物不进入生产路径。

**步骤：**

1. 冻结 `runtime.json`：绝对NODE_BIN（已观察路径 `/Users/luo/.nvm/versions/node/v22.16.0/bin/node`）、可执行文件SHA-256、realpath、完整`process.versions`、架构、macOS build、native工具链。只读核对生产release/launchd实际指向的Node；无法读取则标明生产版本未验证，不用旧手册替代现场。当前入口 `run-isolated-node.sh` 的 `exec node` 与安装器的 `command -v node` 都可能漂移，MAC-02A统一修正。
2. 本卡测量直接使用冻结绝对Node；暂不经仍靠PATH选择Node的broker。先按§0.3/1.1建立并完整核验持久冻结副本，把runtime/thresholds/输入manifest留在`plans/mac-00/<freeze-id>/`，不依赖/tmp跨天保留。记录source/tree、主机资源/APFS、已有服务只读状态及四仓输入commit/hash；缺失/损坏输入从指定commit重建独立副本，不修改历史或业务原仓。
3. **先做一轮探索spike再重做schema。** lishu-v2旧路径完整cold build并记录parse/resolve/graph/search/SQL/checkpoint各阶段及CPU/墙钟，逐source root报告discovered/indexed/failed/recovered、buildState、coverageRevision、integrity与census校验。关闭所有写句柄、checkpoint后用一次性clonefile探针克隆。自然状态不能进入非recovering时，如实标记该分支不可测；不得改写原基线或冒充自然增量成功。
4. 为同一封闭基线分别创建独立0/20/200变化副本：A仅模拟目标stat重戳；B实际内容差量并走非recovering入口；C二者组合。若B/C被coverage阻挡，**仅在结构完整、census一致且退化原因已归因时**，允许在独立一次性副本将buildState/coverageRevision设为READY/1，并记录`forcedNonRecovering=true`、原值/改值及副本digest；条件不满足仍不可测。保存精确changed/affected/实际parsed清单与计数，未编辑FAILED文件仍可能重解析，必须单列，不能称纯20/200 delta。分开报告file/resource stat、facts、graph/search和索引的页/写入增长。dbstat/页计数只是结构归因；物理COW按§5.4测量。强制分支只用于旧布局成本归因，不作正确性、自然增量可用性或收益门PASS，不发布、不作为正式base；新schema与seed仍由G05/G11证明。
5. 用spike决定MAC-04/05的布局和闭包实现。10%/30%物理增长、5 s/15 s首证据是默认承诺目标；维持或收紧无需额外确认。任何放宽必须在目标实现和采用放宽值的正式运行前取得用户明确批准，并在`thresholds.json`记录默认值、拟定/采用值、原因、未满足收益、批准人、批准时间及授权引用；等待答复不算批准，未获批准继续按默认值验收。必须保留外部请求截止、隔离/正确性与K门。候选测量开始后阈值锁定，失败只能修复或报告，不能再改到通过。
6. 需要相对full提速基线时再收集≥3次有效full取B_full中位数；同因已确认无法完成不盲重试，采用§2.6未测基线分支。历史活锁NOT_REPRODUCED不阻塞已独立确认的缺陷。2026-10-14已补测：旧源码`9b3a110`、不插桩、3次有效full，B_full=409.9 s（各次393.6/409.9/419.7 s，主机load 15–21），聚合见[`mac-00/b-full.json`](../../../index-lifecycle-v2/mac/mac-00/b-full.json)，私有原始记录在工作根`plans/mac-00/bfull-20261014T145654Z/`；它是负载主机上的基线，G11须记录自身load并在相近负载下比较或披露差异。

**验收G00：** runtime、四仓和spike身份可重建，权威冻结输入/批准记录/runtime均在持久根；status、fsck及输入路径/hash核验通过。每次probe的execPath/versions/digest与冻结一致，否则运行INVALID_EXPERIMENT、G00 FAIL。有效spike完成或明确给出不可测分支和设计限制，不能把没跑写成0增长。输出runtime/input/baseline/spike/thresholds/run-plan清单；MAC-04/05不得先落地再补spike。生产runtime若不一致，先明确选择统一目标再验证，不自动升级。
