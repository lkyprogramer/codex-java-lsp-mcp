# b9 基线登记（R00 产物）

本文件是 `docs/java-specialist-release-audit-v1.1` S0 的冻结输入登记：source / dataset / scorer / protocol 的完整哈希、原字节恢复记录，以及历史 LIVE 运行的失效清单。它不是新的任务集，不改变任何 frozen gate。

## 1. 源基线

- 基线提交：**b9c3cc3**（`chore: ignore .commandcode local tool state`，branch `codex/java-specialist-devkit-v1`，已 fast-forward 至 `origin/main`）
- 本登记产生于新分支 `codex/java-specialist-release-audit-v1.1`（自 b9c3cc3 切出）
- 若执行时 HEAD 已变化：按 RUN_AI.md 重跑反例并记录差异，不得用 b9 行号直接 patch 新代码

| 输入 | SHA-256 |
|---|---|
| `package.json` | `8377234269a1e49d11a1a024f46f42bb338e2df9a19466a210edccc793323f96` |
| `package-lock.json` | `fc612ac3b894495daab26226e08ac171cab20e62f20b56da7bdc14e49245ef9c` |
| Node | v22.19.0（项目锁定工具链） |

## 2. 冻结评测集（devkit 与 baseline-kit 逐字节一致）

| 输入 | SHA-256 |
|---|---|
| `dataset/manifest.json`（devkit 与 `baseline-kit/dataset/manifest.json` 相同） | `6233410947b1a4bbe1860789856f7789af7cf29e6092d4de5143f7202227b223` |
| `harness/scoring.py` | `5c41e12a994a7a9269725e94646bfb691e6929c2d3dba7c306255754095d4a28` |
| `harness/selfcheck.py`（baseline-kit 拷贝） | `83a7c7d81f99e11a337a7a221202adf409d1dc61cfd7c14b44788124f0431f32` |
| `harness/baseline.py` | `975dcd1a5bdf4780319876348b38aa63694e072f39de7e989e0dcaf2ab253def` |
| `schemas/gates.json` | `6125a647eb31dc5fa9093cf4e4b08f70d1ea402a91d6cb777bb53acb6211844b` |
| `docs/05-evaluation-protocol.md`（baseline-kit 拷贝） | `b8928142329b2fd73d89cac7397e2d4f0713204a797aece9646bbb87c2195740` |

`baseline-kit/SHA256SUMS` 与包内 `tools/check_bundle.py`（357 文件校验）在 S0 时点全部 PASS。

## 3. 原字节恢复（A01 的唯一已确认修复）

| 项 | 值 |
|---|---|
| 文件 | `docs/java-specialist-devkit-v1/dataset/contracts/fixtures/unicode/src/main/java/demo/Unicode.java` |
| 漂移前（BAD，LF 归一化） | `42f1c89bcc4ced94b42e738de6f536104b13be8a809645ccbd6611cdc5aa681b` |
| 恢复后（GOOD，原 CRLF） | `294cd139daf877efe01a66a81da59ca3ec652806837da749eb60486eb0dd43b3` |
| 恢复方式 | `tools/restore_frozen_unicode.py --apply`（只写这一个文件，不改 manifest） |
| 防再漂移 | 根 `.gitattributes` 增加 `docs/java-specialist-devkit-v1/dataset/contracts/fixtures/unicode/src/main/java/demo/Unicode.java -text`（精确路径，不做 mass normalize） |
| fresh-clone 验证 | 临时 clone 后 `file` 显示 `with CRLF line terminators`，SHA-256 = GOOD（`.gitattributes` 随提交生效后才可验证；属性未提交前 clone 会再次漂移，这正是本次事故形态） |

漂移原因**未证明**（可能是某次 checkout/编辑工具的行尾转换）；不指控篡改。MANIFEST 未更新、未接受坏字节。

## 4. 版本三分（本次不得假定 installed = b9）

- **current**：本 checkout HEAD（b9c3cc3 + R00 提交）
- **installed**：线上 38456 部署版本——本次审计未测量，记 UNMEASURED，不混入任何结论
- **measured**：各历史运行目录记录的 `source_sha`（如 M3 closure preflight 记录 `3d509e0a…`、M3 boundary 记录 `6617f27`）——同一 milestone 内测量对应的源码版本以该目录 preflight/manifest 为准

## 5. 历史 LIVE 运行失效登记

`invalidated-runs.json`（同目录，schema `invalidated-runs/v1`）列出 12 组、共 572 次 LIVE agent/repair 运行，全部 `INVALID_EXPERIMENT`、`causalClaimEligible=false`。依据（`docs/java-specialist-release-audit-v1.1/docs/01-audit-report.md`）：

1. **A01**：冻结 Unicode fixture 字节漂移 → M3 边界 "dataset 零 diff" 在字节口径不成立；
2. **W01–W05**：最终 model tool-message 载荷丢失 / 交付语义不可信 / SOURCE_RECEIVED 可先于有效载荷；
3. **E01–E04**：LIVE 评分路径的类型强转与分母口径缺陷。

所有模型共用同一错误 loop——**换多个模型不能排除同一系统性混淆**，跨模型一致不构成稳健性证据。

保留的边界：
- 0/24（及 0/33）repair 冻结测试结果**仍是当时工作区状态的真实性失败**；但"失败源于模型拒绝而非 harness"这一归因**不被这些数据支持**（审计报告第 47 行口径）；
- **检索层 A2/A3 recall 数字不受影响**（不经过模型 chat loop），KEEP_EXTERNAL 作为*隔离政策*（dense 不进产品依赖树）仍可保留，但其"无伤害/能力封顶"类*证据性*表述划为 INVALID_EVIDENCE；
- 失效记录仅可用于 R01–R04 修复后的复测对照，不得再用于能力归因或 release 资格。

## 6. S0 完成证据

- RED：`java-specialist-audit-runs/r00-red`（selfcheck：dataset=2、unit=1（1 FAIL/1 ERROR）、repair-oracles=2）
- GREEN：`java-specialist-audit-runs/r00-green`（selfcheck 5/5 通过：dataset/unit/repair-oracles/upstream/faultcheck 全 0）
- 反例基线：`java-specialist-audit-runs/baseline-counterexamples`（27 项中 26 FAIL，exit 1，与包预期一致；反例修复属 S1/S2 各任务，不在 R00 范围内）
- 冻结集零改动：上表哈希在恢复前后不变（`restore_frozen_unicode.py` 只写 Unicode.java 单文件）