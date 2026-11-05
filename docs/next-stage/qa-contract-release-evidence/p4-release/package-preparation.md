# 私有发布源码快照准备

状态：**PREPARED_NOT_INSTALLED**。独立 locked 输入仍缺失；此快照不代表完整发布资格通过。

快照 `/private/var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/java-lsp-qa-release-t14dzuaq/p4-release/package-candidate` 包含 1606 个实际源文件，34931411 字节。仅在该临时目录创建一个本地验证 commit：`c022bb76fe5c44a5494f350cc59efb2f552f9b3d`；tree：`80c3df028cb1f498b8106e12661389f9613f7cbb`。没有修改主仓库、原候选 index/refs，没有 push。HEAD 的全部 blob 与实际复制字节逐文件核对一致。

原候选 `/private/var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/codex-java-lsp-isolated-validation-zlPTg7/candidate` 的 candidateIdentity 在复制前后相同。快照由原候选 helper 核对 sourceDigest=`6d031e959f5b9a2824f0165b9deeb4aab98ba5cd3679312c8973139ffa129864`、files=611、dirty=false、lockfileHash=`fc612ac3b894495daab26226e08ac171cab20e62f20b56da7bdc14e49245ef9c`。原根 installer/daemon 入口和许可的 hash/mode 已保存在 package-source-manifest.json，原许可与可执行位已保留。没有伪造 BUILD_SHA；未来安装必须由原 installer 读取此真实快照 HEAD。

复制来自 candidate Git cached+others 非 ignored 路径，并沿用 install-runtime.sh:249-270 的 rsync 排除。node_modules/dist/artifacts/.workflow/graphify-out、覆盖率与运行产物、.env 和 .env.* 均排除。唯一明确例外是原审计 MANIFEST 的 357 个冻结文件：34 个 Git ignored 历史 log 按原 SHA 补入并在私有快照中强制 track，使原 check_bundle 校验完整。原 installer 的 *.log 排除保持不变，因此这些历史 log 是源码验证证据，不声称会进入安装 release。

已执行最窄验证：

- candidateIdentity：原输入/复制后源/私有快照绑定一致（私有 baseSha 指向新 commit）。
- verify-clean-source-tree：exit 0。
- 原 tools/check_bundle.py：exit 0，357/357 PASS。
- Git commit count：1；全部 HEAD blob SHA256、复制文件 SHA256 与 mode 检查一致。

未运行 build、tests、模型请求、JDT、daemon startup、实际安装或回滚。未读取/复制认证文件、个人 home、运行 daemon/cache/ownership/pins/MCP config。该目录只供主代理和独立 reviewer 检查；实际安装仍必须使用原 installer，且受原发布门与授权边界约束。
