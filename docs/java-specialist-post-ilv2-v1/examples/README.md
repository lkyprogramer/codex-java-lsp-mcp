# 最终消息校验示例

这是本包根据原创fixture构造的正控制，**不是产品或真实模型运行记录**。

```bash
python tools/check_delivery.py --request examples/final-request.json --receipt examples/receipt.json --view examples/view.json --workspace fixtures/projects/navigation
```

预期REQUEST_BODY_VERIFIED。它不证明网络发送、模型理解或任务成功。篡改request或source后应拒绝；修改请在临时副本进行，不能覆盖原SHA256SUMS。
