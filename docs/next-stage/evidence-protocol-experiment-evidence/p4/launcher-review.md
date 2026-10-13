# P4 launcher 最终独立复审

2026-10-11。结论：PASS，无剩余阻断 finding。可由根代理按既定门禁重新 prepare，再执行 full；本评审不触发模型。

## 前次复审与修复确认

前次只读复审最终版本 SHA256 `93fe5048652c5d0c4b3c19f11d0f68e5aaf4fa6790cc525ef476cbe00b328b64`，已确认：

- 完整72个slot，前4个smoke属于原72；诊断24个slot与冻结顺序一致，每题两次反向，profile/blockRepeat作为外部聚合键，原scorer repeat=1不改。
- live答案/submission/usage先持久化，再在克隆上运行原frozen scorer；失败不把JS初判提升为成功。异常终态保留72/24分母，未执行slot列MISSING_RESULT；scorer失败、中途candidate drift和smoke中止均保留已执行证据，没有替换或追加模型尝试。
- 主进程和worker共用P3 PASS、diagnostic依赖full COMPLETE、worker实际模型匹配门禁。实际launch分支在门禁通过后才读取Pi配置；import、prepare、drycheck及fake tests不读取credentials。
- 原150输入按dataset/**、harness/**和schemas/gates.json验证实际文件集与每文件hash，拒新增、缺失或symlink；绑定launcher、candidate、原protocol、公开native/submit/product schemas与prompt。范围外README、unused adapters及历史报告不参与实际任务/scorer输入。
- MAX_COMPLETION_TOKENS且usage实测时保留普通任务失败；独立runtime/setup或usage缺失才阻断smoke。connect失败也计时；blockWall包含workspace/session/model/repair judge/close，QA scoring另计，overall含评分编排。
- orderingSeed=1984是编排seed；providerSamplingSeed=null，不能宣称provider采样seed已发送。staticReaderCount=1及production default已冻结，P3双reader容量实验不混入本轮profile比较。

前次验证证据：已读取owner原始TAP `/private/tmp/p4-launcher-offline-tests.tap`，14 tests / 14 pass / 0 fail。覆盖完整72/24fake成功、真实Python frozen单QA false/missing映射、scorer失败先落盘、live中止、门禁、connect失败、kit新增/缺失及评分后漂移。评审代理未重跑这14项。

## CLI入口缺陷与最小修复

前次验证覆盖import/helper执行路径，没有覆盖通过macOS /var别名调用CLI。根代理实际prepare/drycheck/full均exit0但无输出，定位为 `path.resolve(process.argv[1])` 保留 `/var`，而Node import.meta.url为realpath `/private/var`，main guard不相等，静默跳过整个main。因此这些调用不构成模型执行或已开始计划slot。

本次仅将末行guard改为 `fs.realpathSync(process.argv[1]) === launcherPath`，在Node普通ESM真实路径语义下正确识别别名/符号链接入口；main guard仍保护普通模块import。其余计划、门禁、评分、计量和副作用边界没有变化。

新增CLI测试创建临时symlink，使用Node调用且不提供参数。期望exit1和公开usage错误；main在参数检查处退出，不导入candidate、不读取credentials、不打开MCP、不发provider请求。临时链接由测试finally清理。

已独立读取：

- `launcher-cli-red.tap`：1 test，0 pass / 1 fail / 0 skip，expected exit1、actual exit0，确证原问题。
- `launcher-cli-green.tap`：1 test，1 pass / 0 fail / 0 skip，确证修复。

当前证据为14项此前PASS + 1项新增定向repair PASS，不能表述为本版本重新执行完整15项；按根代理要求不重跑14项。两组测试均离线，不证明真实provider/MCP模型行为。

## 最终冻结与未执行边界

本次只读复核文件哈希：

- launch-model.mjs SHA256：`cf0af3f61bfa021eaab66a10d5c659580e600a40a03f9140ce8bdcb405247b02`。
- launcher.test.mjs SHA256：`1d3c40aad4b051b6e4fa44546ccf8ce42513bc5e0418792dc540e2afb76d1b0a`。

复核时preregistration.json不存在、full运行目录不存在，full.log为0字节。此前静默CLI记录保留，不冒充已执行请求；根代理重新prepare将绑定修复后的launcher hash。不得用此前旧hash的预注册启动实际模型。

保留限制：全部题已暴露，不宣称泛化；method→XML模型层未测；firstProductQuery包含lazy index准备和查询，独立indexBuildDuration UNMEASURED。真实provider参数遵守、usage/receipt覆盖及MCP生命周期待本轮实际raw审计。硬kill/power-loss不能依靠JavaScript finally生成终态，不能从日志缺失推定成功。

本代理只读检查源码、测试、TAP及文件状态并写本评审文件。未运行模型、MCP、CPU benchmark、credentials读取、prepare或原14项测试；未修改repo、launcher、测试或冻结输入。
