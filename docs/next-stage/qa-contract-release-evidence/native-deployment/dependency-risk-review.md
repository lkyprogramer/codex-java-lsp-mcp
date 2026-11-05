# Dependency risk review

**未发现当前路径实际可达的 blocking 或新增 critical。告警必须保留；npm audit 并非 clean。** 本次仅审查 proxy-addr critical、SDK OAuth high 与 fast-uri high 的现有触发路径，不修改冻结 611 文件或 lockfile。

保存的 dependency-audit.json 实际包含 6 个 package 条目：3 moderate、2 high、1 critical；一个 package 可能含多条 advisory。当前 workspace、旧 09 checkout 和候选 a77 的 package-lock.json SHA 均为 `fc612ac3b894495daab26226e08ac171cab20e62f20b56da7bdc14e49245ef9c`。这是本次安装暴露的既有依赖告警，不是本次新增依赖版本，也不能描述为“零漏洞”。

## Critical：proxy-addr 2.0.7

[官方 GHSA-jqcg-44mw-7w3h](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h) 的触发条件是应用配置短前缀 IPv4-mapped IPv6 或零前导位 IPv6 trusted subnet，并依赖转发 IP 做信任判断。src/http-server.ts:137–159 创建外层 Express app，没有设置 trust proxy 或安装父级 Express app；所装 node_modules/express/lib/application.js:99 默认设置 false。src/http-server.ts:363–365 固定绑定 127.0.0.1。当前应用未配置 advisory 所需 trust-subnet 条件；因此没有证据将这一真实 package critical 告警认定为当前可达 critical。结论依赖当前配置，不能外推到以后开启 trust proxy 的部署。

## High：SDK 1.30.0 OAuth client

[官方 GHSA-6qxp-vccf-f47h](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h) 要求 HTTP OAuth client 持有凭据，并由不可信 MCP server 指定另一 authorization server；官方将 SDK server 与 stdio client 排除在此漏洞影响路径外。当前产品使用 SDK server。src/smoke-http.ts:24–27 的唯一 smoke HTTP client 没有 authProvider，117–125 行拒绝非精确 loopback /mcp URL及 URL 凭据。src/scripts 未发现 withOAuth、auth/fetchToken 调用。所装 transport 仅在 _authProvider 存在时调用 OAuth。当前没有这条凭据发送路径，不能由 SDK package high 告警直接推出当前产品会泄漏 OAuth 凭据。

## High：fast-uri 3.1.5

已核对官方 [IPv6 normalization SSRF](https://github.com/fastify/fast-uri/security/advisories/GHSA-f65p-4m7j-42xc)、[重复 hostname 解码](https://github.com/fastify/fast-uri/security/advisories/GHSA-fph4-wmhf-6fwf) 和 [serialize port authority injection](https://github.com/fastify/fast-uri/security/advisories/GHSA-qw65-cvwx-89v3) 条件。安全影响需要 consumer 将攻击者 URL 的解析结果用于出站请求、重定向或 host 策略。

实际依赖链是 SDK→Ajv→fast-uri；SDK 的 validation/ajv-provider.js 使用默认 Ajv 同步 compile，没有 loadSchema。Ajv compileAsync 需要显式 loadSchema 才能载入远端 schema。当前 src/scripts 未发现 fast-uri 请求或 host-policy sink；smoke URL 由 Node URL 及 loopback 规则校验。未观察到从恶意 URL 经 fast-uri 到出站请求的 SSRF 链。fast-uri 本身仍存在受影响解析行为；本结论不声称所有 URI advisory 已做利用验证或所有 schema 语义不存在缺陷。

## 范围与后续

hono、ip-address、qs 三个 moderate package 的 raw 告警保留，未逐漏洞利用验证。没有运行 exploit、模型、benchmark、installer 或其他 tests。Express 默认 false 在已安装源码中核对；主代理另行内存检查的结果不冒充本代理执行证据。

当前最小处理是披露既有条件告警，在独立后续依赖修复中更新 lock并做相关回归验证。若以后增加 trust proxy、OAuth client、远端 schema loader 或出站 URL 策略，必须重新评估这些触发路径。此次结论不改变既有资格门或冻结源码，也不替代实际 native proof。
