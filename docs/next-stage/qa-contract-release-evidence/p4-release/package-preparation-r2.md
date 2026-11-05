# 私有发布源码快照 r2

状态：**PREPARED_NOT_INSTALLED**。独立 locked 输入仍缺失，不宣称完整发布门通过。

新快照 `/private/var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/java-lsp-qa-release-t14dzuaq/p4-release/package-candidate-r2`，唯一私有 commit `a77b6428ca432259c4008ead6c5e58cdc5e53cef`，tree `0a962ef0bf631e9bb19c849d8ee18ca938774e02`。1843 个文件、49051801 字节。原首版 commit `c022bb76fe5c44a5494f350cc59efb2f552f9b3d` 与原 manifest 原样保留。r2 以首版的精确源文件字节为底，仅从 primary repo 补入本次明确请求的12项版本合同/计划/历史评审，并按本地Markdown目标及原证据manifest的path+SHA闭包复制 237 份必要文档/证据，14120390 字节；没有盲复制目录、认证、缓存或 artifacts。

每个新增文件的来源绝对路径、相对路径及原SHA写入 package-source-manifest-r2.json。public-answer-contract-v1.0.json 与 ROOT/p0-contract 原登记字节一致（2debcf5ef20d58e6e994025f4d5a69861d3e869e0f67b8a2780ee59b6592f1d3）；v1.4 与 p0 coverage-check 原冻结摘要一致（a2f06a1cfa3ce2c9457495d49d0dc7e5a7fdc5ba66fd9696a14a8ed66e71f5c5）；v1.5 与实际候选active protocol字节一致（c9c6682b434793707e7538b449a5fb78900e3c95c8f77bda63e6c02e138833c6）。全部README本地链接和本次文档的必要本地引用目标存在；原raw中的历史执行绝对路径没有跨界访问或改写。

历史 release-evidence.json、release-verdict.json 与证据文件保留原始字节及NO_GO，不用于冒充本次r2发布资格。所有原冻结357文件仍PASS，原scorer/tasks/gold保持原SHA；原 installer/daemon/root入口和许可hash与首版相同。sourceDigest仍 `6d031e959f5b9a2824f0165b9deeb4aab98ba5cd3679312c8973139ffa129864` /611、dirty=false。全部新commit blob与文件SHA一致，mode保留。

最窄检查：原candidateIdentity绑定一致；verify-clean-source-tree exit0；check_bundle.py exit0 357/357 PASS；仅一个本地验证commit。未build/test/model/JDT/start/install，未伪造BUILD_SHA，未修改主repo/旧快照/旧证据/运行配置。
