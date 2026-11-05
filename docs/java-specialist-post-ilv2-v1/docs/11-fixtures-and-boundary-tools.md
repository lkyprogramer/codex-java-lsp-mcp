# 11 机制附件和最终消息检查器

## 使用范围

本包的原创fixtures覆盖8个机制组，每组3个验收case。它们是Q03–Q08可移植的回归素材，不是24个随机真实业务问题，更不是独立第三方盲测。组内case相关；中文/英文改写不增加样本量。

fixtures只含源码、构建布局和关联资源。`evaluator/cases.json`、控制oracle、报告和本计划均不得进入产品索引或Agent工作区。真实测试时只复制某个`fixtures/projects/<group>`目录。

源代码不带`EXPECT`/gold标记；标签用源字节hash与实际行范围定位。人工或AI查看labels后，该集合就是exposed regression，不能再称为holdout。

## 与真实框架的边界

frameworks组含为了语法抽取而编写的最小注解声明。它不启动Spring、不模拟容器，也不证明Profile/Qualifier真实装配。resources组的mapper XML可验证namespace与坐标，但不代表完整MyBatis运行行为。binding组用JDK执行少量重载/动态调用控制；JDT引用结果必须在Mac产品上另测。

## 已提供命令

```bash
python tools/check_fixtures.py --output /tmp/fixtures.json
python tools/check_delivery.py --help
```

前者验证所有label的源hash/范围，编译独立project/source set，执行已登记JDK控制。不安装依赖、不联网、不写源目录；构建临时目录在结束后删除。异常与编译失败分别报告，不能靠skip转绿。

## Receipt输入规范

`check_delivery.py --request FINAL_REQUEST_JSON --receipt RECEIPT_JSON --workspace AUTHORIZED_ROOT --view HELD_VIEW_JSON`

receipt需要schema=`post-ilv2/evidence-receipt/v1`，requestBodySha256、workspaceId、contentManifestId、units。每unit有唯一id、toolCallId、messageIndex、textPointer（tool content为JSON字符串时的JSON Pointer；空字符串表示整个纯文本content）、relativePath、contentHash、startLine、endLine、previewKind=`source`。

检查器使用实际最终request body字节校验body hash，再读取指定tool message中的正文位置，验证其完全等于本地源码范围；拒绝路径逃逸/软链接/非普通文件、重复unit、错误hash/范围、redacted内容、错误toolCallId/role和超预算。不接受仅仅在请求任意地方出现了同一句话。

**信任边界：**只能证明提供给检查器的request文件与本地源码匹配，不能证明网络已送达、模型已理解或任务成功。LIVE适配器必须在真实最终序列化点生成该文件，另记录provider回执。攻击者有权改request/receipt/源码时它不是安全认证系统。

## 输出与退出码

通过输出`REQUEST_BODY_VERIFIED`；不合格退出1；输入文件/环境异常退出2。测试其拒绝行为不等于运行本产品的MCP链。固定相对path+hash是证据身份；workspace字符串不是安全访问权限，访问权限仍由产品root策略负责。

## 扩展规则

增加新Java机制case时补source、case标签、编译控制和变异体。不能根据新候选输出来改旧label。若文件换行改变需要新fixture版本或恢复原bytes，不能静默刷新manifest。新增源码必须无私有业务代码/凭据。

每份receipt只验证一个已冻结预算的交付批次，默认8 units/80行/16000 bytes；不是对整个多轮历史施加80行上限。`--view`来自评测侧捕获的held view，不仅相信receipt自己声明的workspace。


## 产品运行前的隔离物化

产品如果要求Git根，只在临时复制目录初始化，不修改包内冻结字节：

```bash
OUT=$(mktemp -d /tmp/post-ilv2-corpus.XXXXXX)
cp -R fixtures/projects/navigation "$OUT/work"
git -C "$OUT/work" init -q
git -C "$OUT/work" add .
git -C "$OUT/work" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm fixture
```

随后通过用户既有隔离runner登记这个root。不要将整个套件目录作为repoRoot，否则evaluator标签会泄漏。frameworks中的同名注解stub只有语法形状意义，不能放进真实业务仓库或作为实际Spring依赖替代。
