# Agent 任务与修复验证操作

## Stage一个任务

```bash
python -m harness stage --task JSB-PAYMENTS-03 --output /tmp/java-agent-case
```

Agent只得到 `/tmp/java-agent-case/repo` 和 `task.json`，不得看到本包gold/repairs/reports。scratch、classes、logs放repo外。不要把全ZIP解压目录交给被测Agent作为workspace，否则它可以直接检索答案。

Agent完成后，evaluator执行：

```bash
python -m harness repair --task JSB-PAYMENTS-03 --mode candidate --candidate /tmp/java-agent-case/repo --output /tmp/repair-result.json
```

判断器比较candidate与原始fixture的全部文件hash，任何非allowed_edits变动都拒绝；再复制干净原工程，只覆盖允许源码，注入evaluator-owned测试到外部judge目录，javac -proc:none编译，java -Xmx128m执行。测试文件不从Agent目录读取。测试main抛AssertionError表示业务失败，System.out里写PASS无效。外部FrozenJudgeRunner只有在测试main正常返回后才写本轮完成回执；缺少回执，即便JVM退出码为0也失败。回执是完成性检查，不是对同权限恶意代码的安全沙箱。

## Recorder协议

每次工具调用记录callId/toolName/argumentsHash/start/end/status。真实源读取事件记录path、contentHash、inclusive lines、exact text、origin（tool_response或explicit_read）、callId。工具只返回path/range时仅进入regions，不进入read_events；读取器随后读到原文才产生receipt。

SUT的摘要、模型复述、引用ID不能伪造源读取。host recorder理论上仍可被同权限恶意进程伪造，可信评测必须隔离owner和Agent权限。当前scorer验证text/hash一致性，但不声称证明模型在神经层面真正使用了证据。

## 回答格式

QA要求answer JSON键名及类型按task.output_contract，模型可另输出解释，但auto-grade只用明确字段与证据。成功例：{"answer":{"method":"accept","storageType":"Set<String>"},"read_events":[...真实源文本...]}。这些不是参考输出模板给锁定任务泄漏值；示例只用于dev。

repair输出由实际文件diff决定，不要求文本answer正确即可通过。记录Agent声称、实际diff、外部测试三个字段，不能合并。

## 真实任务测量不自动执行

本包没有运行任何付费/本地模型，因此没有现成的Agent成功率或省token百分比。configs/experiment.json提供可预注册pilot，宿主适配器必须提供raw usage与真实工具记录后才可出M2/M3结论。
