# 机器协议与适配

`schemas/result.schema.json` 描述规范result pack。当前Python validator是裁决实现，JSON Schema作为文档/编辑器辅助；遇到差异以versioned validator tests为准并修正schema，不在单次结果里临时放宽。

输入adapter：单行/单个JSON，包括schema、task（无gold）、variant、repeat、repo_root、output_cap_bytes。stdout只输出一个result JSON，stderr仅日志。单条结果包含task_id、status、candidates、regions、read_events、answer、usage。区域hash是整个当前文件SHA-256，text是inclusive行窗口的原始UTF8解码文本，包括CRLF。

声明name与line来自解析结果，不从gold查找。内部SUT id可保留诊断，独立score不要求采用特定id编码，因此不会为了配合实现错误而一起改变。

```json
{
  "task_id":"EXAMPLE",
  "status":"OK",
  "candidates":[{"path":"src/main/java/demo/A.java","line":8,"name":"save"}],
  "regions":[{"path":"src/main/java/demo/A.java","start_line":8,"end_line":12,"content_hash":"file-sha256"}],
  "read_events":[],
  "answer":null,
  "usage":null
}
```

以上是结构示例不是可提交结果；file-sha256必须是实值。read_events为空表示只取得计划，绝不是已读。

目标MCP adapter的运行示例（M1已经实现，另起隔离canary后）：

```bash
python -m harness run-adapter --split dev --arm static-m1 --source-sha YOUR_REAL_SHA --command-json '["python3","/absolute/devkit/adapters/mcp_static.py","--url","http://127.0.0.1:38457/mcp"]' --output /tmp/m1-results.json
python -m harness score --split dev --input /tmp/m1-results.json --output /tmp/m1-report.json
```

`YOUR_REAL_SHA`由preflight取得，不是硬编码示例SHA。路径必须绝对，因为adapter cwd是临时repo。MCP adapter只采集static discovery；它不替Agent自动回答/修复，也不默认query→impact多跳。需要测真实Agent选择/impact，应由host recorder走Q/P轨道。

当前snapshot旧工具会拒绝/不返回M1契约；adapter返回UNSUPPORTED是正确行为。fake HTTP测试只证明运输/归一化代码，不证明真实SUT可用。
