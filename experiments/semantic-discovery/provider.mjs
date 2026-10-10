// input:  T10 可选语义发现实验 - 独立包，不进产品依赖树（stock 外部向量路线）。
//         一个 OpenRouter 兼容 embedding provider（液金 350M，1024 维），
//         对 SearchDocument 对齐的文本做 dense 索引与检索，产出 DISCOVERY_HINT。
// output: DiscoveryHint[]（provider/index 身份、路径、行范围、rank、可得 contentHash）；
//         provider 故障/超时/离线/无授权安静返回空提示，调用方回退 A2，不重试风暴。
// pos:    docs/10 阶段 Z1/Z2 - 相似性证据只标 DISCOVERY_HINT，绝不标 JDT_BOUND；
//         无 indexedContentHash 时调用方必须重读并重新定位声明，不承认旧行号。
// 授权:   用户显式提供 OpenRouter key（仓库外存储）并授权网络与免费 embedding 推理。
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const HINT_AUTHORITY = "DISCOVERY_HINT";
/** Cache epoch for a model whose revision the endpoint does not report. */
export const UNVERSIONED_CACHE_EPOCH = "2026-10-10";
const IDENTITY_FIELDS = ["endpoint", "provider", "model", "revision", "dim", "metric", "representationVersion", "declarationId", "textHash", "sourceManifestHash"];

/** sha256 over canonical JSON of exactly the identity fields (never a credential). */
export function cacheIdentity(fields) {
  for (const name of Object.keys(fields)) {
    if (!IDENTITY_FIELDS.includes(name)) throw new Error(`cacheIdentity: unexpected field ${name}`);
  }
  for (const name of IDENTITY_FIELDS) {
    if (fields[name] === undefined || fields[name] === null) throw new Error(`cacheIdentity: missing field ${name}`);
  }
  const canonical = JSON.stringify(IDENTITY_FIELDS.map(name => [name, fields[name]]));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
export const EMBEDDING_DIM = 1024; // 历史默认（lfm-2.5）；实际维度以首次响应探测为准（this.dim）。

/** docs/10 Z1 契约：提示的身份与可信度边界。 */
export function discoveryHint({ provider, providerIndexIdentity, relativePath, startLine, endLine, rank, indexedContentHash }) {
  return {
    provider,
    providerIndexIdentity,
    relativePath,
    startLine,
    endLine,
    rank,
    ...(indexedContentHash ? { indexedContentHash } : {}),
    authority: HINT_AUTHORITY
  };
}

/**
 * OpenRouter 兼容 embedding 客户端。批量优先；任何失败抛 EmbeddingProviderError，
 * 由调用方决定安静回退（仅对 429/5xx 做有限退避，最多 maxRetries 次）。
 *
 * R10:
 * - timeoutMs 是每个批次的总时限：连接、header、body 解码、所有重试与退避
 *   都在同一个截止时间内，放不下的退避不开始；每次尝试的 timer 都在 finally 清理。
 * - 缓存按 cacheIdentity（endpoint/provider/model/revision/dim/metric/表示版本/
 *   declarationId/文本 hash/源 manifest hash）键控，不含 API key；命中时校验维度
 *   与有限数值，非法或旧格式记录当作未命中。缓存文件每个实例只读一次（内存复用），
 *   有新条目的 embed 调用原子写一次（临时文件 + rename）；单进程 writer，并发进程以最后一次 rename 为准。
 * - 端点不报告模型 revision 时，身份使用显式 epoch（UNVERSIONED_CACHE_EPOCH），
 *   不声称跨时间可复现。
 */
export class EmbeddingProvider {
  constructor({
    apiKey,
    model,
    baseUrl = "https://openrouter.ai/api/v1",
    fetchImpl = globalThis.fetch,
    timeoutMs = 30_000,
    maxRetries = 2,
    cacheFile = null,
    revision = null,
    cacheEpoch = UNVERSIONED_CACHE_EPOCH,
    dimensions = null,
    providerName = "openrouter"
  }) {
    if (!apiKey) throw new Error("EMBEDDING_NOT_AUTHORIZED: no API key");
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.cacheFile = cacheFile;
    this.revision = revision;
    this.cacheEpoch = cacheEpoch;
    this.dimensions = dimensions; // 预期维度；未配置时以首次响应/命中探测（this.dim）。
    this.providerName = providerName;
    this.dim = dimensions;
    this.calls = 0;
    this.batchCalls = 0;
    this.itemsEmbedded = 0;
    this.errors = 0;
    this.latencyMs = 0;
  }

  get provider() {
    return this.providerName;
  }

  /** 请求地址（与 R10 之前相同）。 */
  get requestUrl() {
    return `${this.baseUrl}/embeddings`;
  }

  /** 身份用的端点：去掉凭据与 query 的 origin+path。 */
  get endpoint() {
    const url = new URL(this.requestUrl);
    return `${url.origin}${url.pathname}`;
  }

  /** 与向量语义相关的 provider 身份字段（不含 API key）。 */
  identityBase() {
    return {
      endpoint: this.endpoint,
      provider: this.provider,
      model: this.model,
      revision: this.revision ?? `unversioned:${this.cacheEpoch}`,
      dim: this.dimensions ?? "auto",
      metric: "cosine"
    };
  }

  /**
   * 一个实例内的 embed 调用须串行（缓存是读-改-整体写）。没有 key 的调用
   * 不读也不写缓存（入口脚本的查询向量走 embedQuery，带 key）；只有新写入
   * 条目时才保存（整文件重写），失败的批次之前已成功的批次也会保存。
   */
  async embed(texts, keys) {
    if (!Array.isArray(texts) || texts.length === 0) return [];
    const cache = keys?.some(key => key != null) ? this.loadCache() : undefined;
    const vectors = new Array(texts.length).fill(null);
    for (let i = 0; i < texts.length; i += 1) {
      if (cache && keys?.[i] != null) vectors[i] = this.validCached(cache.get(keys[i]), keys[i]) ?? null;
    }
    // Hits of one identity share one dimension; a disagreeing set is not trusted.
    const hitDims = new Set(vectors.filter(Boolean).map(vector => vector.length));
    if (hitDims.size > 1) vectors.fill(null);
    else if (hitDims.size === 1) this.dim = this.dim ?? [...hitDims][0];
    const missing = [];
    for (let i = 0; i < texts.length; i += 1) if (!vectors[i]) missing.push(i);
    let dirty = false;
    try {
      for (let i = 0; i < missing.length; i += 16) {
        const batch = missing.slice(i, i + 16);
        const fetched = await this.embedBatch(batch.map(index => texts[index]));
        batch.forEach((index, n) => {
          vectors[index] = fetched[n];
          if (cache && keys?.[index] != null) {
            cache.set(keys[index], { key: keys[index], dim: fetched[n].length, vector: fetched[n] });
            dirty = true;
          }
        });
      }
    } finally {
      if (cache && dirty) this.saveCache(cache);
    }
    return vectors;
  }

  /**
   * Query vectors are cached under the same identity as declaration vectors
   * (provider identity + query representation + text hash), so a rerun sees
   * the same query vector even when the endpoint's output drifts slightly
   * over time, and a vector never crosses endpoint/model/dimension.
   */
  queryCacheKey(query) {
    return cacheIdentity({
      ...this.identityBase(),
      representationVersion: QUERY_REPRESENTATION_VERSION,
      declarationId: "query",
      textHash: createHash("sha256").update(query, "utf8").digest("hex"),
      sourceManifestHash: "none"
    });
  }

  async embedQuery(query) {
    const [vector] = await this.embed([query], [this.queryCacheKey(query)]);
    return vector;
  }

  /** 一个合法记录：键吻合、维度一致的有限数值向量；否则 undefined（未命中）。 */
  validCached(record, key) {
    if (!record || typeof record !== "object" || record.key !== key || !Array.isArray(record.vector)) return undefined;
    const { dim, vector } = record;
    if (!Number.isInteger(dim) || dim <= 0 || vector.length !== dim) return undefined;
    if (this.dim != null && dim !== this.dim) return undefined;
    if (!vector.every(Number.isFinite)) return undefined;
    return vector;
  }

  /** Read once per instance; later calls reuse (and extend) the same map. */
  loadCache() {
    if (!this.cacheFile) return undefined;
    this.cacheMemo ??= this.readCacheFile();
    return this.cacheMemo;
  }

  readCacheFile() {
    try {
      const data = JSON.parse(readFileSync(this.cacheFile, "utf8"));
      // 只认 R10 布局；旧的 model::path::hash 布局整体不复用。
      if (data?.layout === CACHE_LAYOUT && data.entries && typeof data.entries === "object") {
        return new Map(Object.entries(data.entries));
      }
    } catch {
      // 不存在或损坏：空缓存
    }
    return new Map();
  }

  saveCache(cache) {
    mkdirSync(path.dirname(this.cacheFile), { recursive: true });
    const temp = `${this.cacheFile}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ layout: CACHE_LAYOUT, entries: Object.fromEntries(cache) }));
      renameSync(temp, this.cacheFile);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  async embedBatch(batch) {
    const deadlineAt = Date.now() + this.timeoutMs;
    let attempt = 0;
    for (;;) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw this.failed(new EmbeddingProviderError(`embedding timeout after ${this.timeoutMs}ms`));
      const outcome = await this.attemptBatch(batch, remaining);
      if (outcome.vectors) return outcome.vectors;
      const backoffMs = 1500 * (attempt + 1);
      if (!outcome.retryable || attempt >= this.maxRetries) throw outcome.error;
      if (Date.now() + backoffMs >= deadlineAt) {
        // Not a timeout: the attempt failed fast, but its retry cannot fit.
        throw new EmbeddingProviderError(`embedding retry budget exhausted within ${this.timeoutMs}ms: ${outcome.error.message}`);
      }
      attempt += 1;
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }

  /** 一次 HTTP 尝试：fetch、状态、body 解码全部与剩余时限竞速；timer 必清。 */
  async attemptBatch(batch, remainingMs) {
    const started = Date.now();
    const controller = new AbortController();
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new EmbeddingProviderError(`embedding timeout after ${this.timeoutMs}ms`));
      }, remainingMs);
    });
    expired.catch(() => undefined);
    const withinDeadline = promise => Promise.race([promise, expired]);
    try {
      this.calls += 1;
      this.batchCalls += 1;
      const response = await withinDeadline(this.fetchImpl(this.requestUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.model,
          input: batch,
          encoding_format: "float",
          ...(this.dimensions ? { dimensions: this.dimensions } : {})
        }),
        signal: controller.signal
      }));
      if (!response.ok) {
        const body = String(await withinDeadline(Promise.resolve(response.text?.()).catch(() => "")) ?? "").slice(0, 200);
        return {
          error: this.failed(new EmbeddingProviderError(`embedding HTTP ${response.status}: ${body}`)),
          retryable: response.status === 429 || response.status >= 500
        };
      }
      const data = await withinDeadline(response.json());
      this.latencyMs += Date.now() - started;
      return { vectors: this.checkedRows(data, batch.length) };
    } catch (error) {
      const failure = error instanceof EmbeddingProviderError
        ? error
        : new EmbeddingProviderError(error instanceof Error ? error.message : String(error));
      return { error: this.failed(failure), retryable: false };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 行数、维度一致、有限数值；错误只降级，绝不当作向量。 */
  checkedRows(data, expected) {
    const rows = Array.isArray(data?.data) ? data.data : [];
    const ordered = rows
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map(row => row.embedding);
    const dim = this.dim ?? (Array.isArray(ordered[0]) ? ordered[0].length : 0);
    const valid = ordered.length === expected && dim > 0 &&
      ordered.every(vector => Array.isArray(vector) && vector.length === dim && vector.every(Number.isFinite));
    if (!valid) throw new EmbeddingProviderError(`embedding shape mismatch: got ${ordered.length} rows for ${expected}`);
    this.dim = dim;
    this.itemsEmbedded += expected;
    return ordered;
  }

  failed(error) {
    this.errors += 1;
    return error;
  }

  costReport() {
    return {
      provider: this.provider,
      model: this.model,
      httpCalls: this.calls,
      batchCalls: this.batchCalls,
      itemsEmbedded: this.itemsEmbedded,
      errors: this.errors,
      latencyMs: this.latencyMs
    };
  }
}

/** Vendor keys are only ever sent to their own host. */
const HOST_KEYS = [
  { suffix: "siliconflow.cn", variable: "SILICONFLOW_API_KEY" },
  { suffix: "openrouter.ai", variable: "OPENROUTER_API_KEY" }
];

function hostMatches(host, suffix) {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/**
 * Provider from the environment (entry scripts). EMBEDDING_BASE_URL selects
 * the endpoint (default OpenRouter); the key is EMBEDDING_API_KEY (explicit,
 * any host) or the vendor key bound to that host (SILICONFLOW_API_KEY for
 * *.siliconflow.cn, OPENROUTER_API_KEY for *.openrouter.ai) - a vendor key is
 * never sent to another host. EMBEDDING_MODEL (or OPENROUTER_EMBEDDING_MODEL);
 * optional EMBEDDING_DIMENSIONS (sent as `dimensions`, part of the identity)
 * and EMBEDDING_PROVIDER (defaults to the endpoint host).
 */
export function embeddingProviderFromEnv(env, { cacheFile = null, timeoutMs = 60_000 } = {}) {
  const present = name => (typeof env[name] === "string" && env[name] !== "" && env[name] !== "undefined" ? env[name] : undefined);
  const baseUrl = present("EMBEDDING_BASE_URL") ?? "https://openrouter.ai/api/v1";
  const host = new URL(baseUrl).hostname;
  const bound = HOST_KEYS.find(entry => hostMatches(host, entry.suffix));
  const apiKey = present("EMBEDDING_API_KEY") ?? (bound ? present(bound.variable) : undefined);
  if (!apiKey) {
    throw new Error(`EMBEDDING_NOT_AUTHORIZED: no key for ${host} (EMBEDDING_API_KEY${bound ? ` or ${bound.variable}` : ""})`);
  }
  const model = present("EMBEDDING_MODEL") ?? present("OPENROUTER_EMBEDDING_MODEL");
  if (!model) throw new Error("EMBEDDING_MODEL is required");
  const dimensions = present("EMBEDDING_DIMENSIONS") ? Number(env.EMBEDDING_DIMENSIONS) : null;
  if (dimensions !== null && !(Number.isInteger(dimensions) && dimensions > 0)) {
    throw new Error(`EMBEDDING_DIMENSIONS must be a positive integer, got ${env.EMBEDDING_DIMENSIONS}`);
  }
  return new EmbeddingProvider({
    apiKey,
    model,
    baseUrl,
    dimensions,
    providerName: present("EMBEDDING_PROVIDER") ?? host,
    timeoutMs,
    cacheFile
  });
}

const CACHE_LAYOUT = "dense-cache/r10";
/** Query text is embedded verbatim (no SearchDocument join). */
export const QUERY_REPRESENTATION_VERSION = "query-verbatim-v1";

export class EmbeddingProviderError extends Error {
  constructor(message) {
    super(message);
    this.name = "EmbeddingProviderError";
  }
}

/**
 * Dense input from the product index: each SearchDocument's ordered,
 * already-redacted normalizedText (search_doc_text, index schema v8+). The
 * text is the same representation the A2 postings were tokenized from, so
 * dense and lexical compare one text surface.
 *
 * An index without search_doc_text (schema < 8) only has unordered token
 * postings; rebuilding "text" from them is a different representation, so
 * that index is refused (DISABLED_INVALID), never approximated.
 *
 * Each fact: relativePath = the declaration's own (owning) file, sourcePath +
 * contentHash = where the text was read from (a MyBatis statement's XML).
 *
 * The build state and every document are read in one snapshot, and only a
 * READY snapshot is accepted: a cold build in progress has written only part
 * of the documents (INDEX_NOT_READY; see waitForReadyIndex).
 */
export function readSearchDocumentFacts(_repoRoot, dbPath) {
  // A short writer checkpoint must not fail the whole run.
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5_000 });
  try {
    db.exec("BEGIN");
    const hasText = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='search_doc_text'").get();
    if (!hasText) {
      throw new Error(
        "DISABLED_INVALID: this index has no ordered SearchDocument text (search_doc_text, schema v8+); " +
        "rebuilding text from unordered token postings is a different representation - rebuild the index"
      );
    }
    const missing = db.prepare(
      "SELECT count(*) AS n FROM search_doc d LEFT JOIN search_doc_text t ON t.doc_sym=d.sym WHERE t.doc_sym IS NULL"
    ).get();
    if (Number(missing.n) > 0) throw new Error(`DISABLED_INVALID: ${missing.n} search documents have no stored text`);
    const state = indexBuildState(db);
    if (state !== "READY") throw new Error(`INDEX_NOT_READY: buildState=${state ?? "absent"}`);
    return db.prepare(
      `SELECT d.sym AS docId, op.text AS relativePath, sp.text AS sourcePath, d.start_line AS startLine,
              d.end_line AS endLine, d.kind AS kind, d.content_hash AS contentHash, ds.text AS declarationId,
              t.text AS text
         FROM search_doc d
         JOIN search_doc_text t ON t.doc_sym = d.sym
         JOIN sym sp ON sp.id = d.source_path_sym
         JOIN sym ds ON ds.id = d.declaration_sym
         LEFT JOIN sym op ON op.id = d.path_sym`
    ).all().map(row => ({
      docId: Number(row.docId),
      relativePath: row.relativePath ?? row.sourcePath,
      sourcePath: row.sourcePath,
      startLine: Number(row.startLine),
      endLine: Number(row.endLine),
      kind: row.kind,
      contentHash: row.contentHash,
      declarationId: row.declarationId,
      text: row.text
    }));
  } finally {
    if (db.isTransaction) db.exec("COMMIT");
    db.close();
  }
}

function indexBuildState(db) {
  const hasMeta = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='meta'").get();
  return hasMeta ? db.prepare("SELECT value FROM meta WHERE key='buildState'").get()?.value : undefined;
}

/** Polls the index until its build state is READY (the product writes BUILDING
 *  while a cold build runs); throws INDEX_NOT_READY at the deadline. */
export async function waitForReadyIndex(dbPath, { timeoutMs = 600_000, pollMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let state;
  for (;;) {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        state = indexBuildState(db);
      } finally {
        db.close();
      }
    } catch (error) {
      state = `unreadable (${error instanceof Error ? error.message : String(error)})`;
    }
    if (state === "READY") return;
    if (Date.now() >= deadline) throw new Error(`INDEX_NOT_READY after ${timeoutMs}ms: buildState=${state ?? "absent"}`);
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Dense 输入表示：每个声明的 SearchDocument 文本按源位置保序拼接。 */
export const DENSE_REPRESENTATION_VERSION = "searchdoc-v2/declaration-join-v1";

const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");

/** 不实现 identityBase 的 provider（测试 fake）：只用它声明的名字。 */
function providerIdentityBase(provider) {
  return typeof provider.identityBase === "function"
    ? provider.identityBase()
    : { endpoint: "unknown", provider: provider.provider, model: provider.model, revision: "unversioned", dim: "auto", metric: "cosine" };
}

/**
 * 对齐表示的 dense 索引：与 A2 共用同一 SearchDocument 文本面，归因才有效
 * （docs/10："能够对齐表示时，比较同一 SearchDocument 上的 lexical/dense/RRF"）。
 * R10: 每个声明一条缓存身份（声明、实际文本 hash、源 manifest、表示版本、
 * provider 身份），所以同文件的两个声明不会共享向量，冷/热构建完全一致。
 */
export class DenseDiscoveryIndex {
  constructor({ provider, facts, corpusHash, repoRoot, representationVersion = DENSE_REPRESENTATION_VERSION }) {
    this.provider = provider;
    this.facts = facts;
    this.corpusHash = corpusHash;
    this.repoRoot = repoRoot;
    this.representationVersion = representationVersion;
    this.vectors = null;
    this.buildCost = null;
    this.indexedAt = null;
  }

  /** 提示与构建记录共用的索引身份：provider 身份 + 表示版本 + corpus。 */
  get providerIndexIdentity() {
    const base = providerIdentityBase(this.provider);
    const digest = sha256(JSON.stringify([base, this.representationVersion, this.corpusHash])).slice(0, 16);
    return `${base.provider}:${base.model}:${digest}:${this.corpusHash.slice(0, 12)}`;
  }

  async build() {
    const rows = this.declarationRows();
    const base = providerIdentityBase(this.provider);
    const texts = rows.map(row => row.text);
    const keys = rows.map(row => cacheIdentity({
      ...base,
      representationVersion: this.representationVersion,
      declarationId: row.declarationId,
      textHash: sha256(row.text),
      sourceManifestHash: row.sourceManifestHash
    }));
    const costBefore = { ...this.provider.costReport() };
    const startedAt = Date.now();
    const vectors = await this.provider.embed(texts, keys);
    const dim = Array.isArray(vectors[0]) ? vectors[0].length : 0;
    if (vectors.length !== rows.length || dim === 0 ||
        !vectors.every(vector => Array.isArray(vector) && vector.length === dim && vector.every(Number.isFinite))) {
      throw new EmbeddingProviderError("dense index: vectors do not match the declaration rows");
    }
    this.buildCost = {
      ...this.provider.costReport(),
      deltaHttpCalls: this.provider.calls - costBefore.httpCalls,
      deltaItemsEmbedded: this.provider.itemsEmbedded - costBefore.itemsEmbedded,
      deltaLatencyMs: this.provider.latencyMs - costBefore.latencyMs,
      wallMs: Date.now() - startedAt
    };
    this.rows = rows;
    this.vectors = vectors;
    this.indexedAt = new Date().toISOString();
    return rows.length;
  }

  /**
   * 全部事实按 (path, declarationId) 归并，行序与文本拼接序都与输入顺序无关：
   * 声明按 (path, declarationId) 排序，文档先自身文件、再其他源文件（按源路径），
   * 同一源内按 (startLine, endLine, kind, text)。
   * 源 manifest 是该声明全部 (源路径, contentHash) 的有序列表的 hash。
   */
  declarationRows() {
    const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const sourceOf = fact => fact.sourcePath ?? fact.relativePath;
    const foreign = fact => (sourceOf(fact) === fact.relativePath ? 0 : 1);
    const facts = [...this.facts].sort((a, b) =>
      compare(a.relativePath, b.relativePath) || compare(String(a.declarationId), String(b.declarationId)) ||
      foreign(a) - foreign(b) || compare(sourceOf(a), sourceOf(b)) || a.startLine - b.startLine || a.endLine - b.endLine || compare(String(a.kind ?? ""), String(b.kind ?? "")) ||
      compare(String(a.text ?? ""), String(b.text ?? "")));
    const merged = new Map();
    for (const fact of facts) {
      const key = `${fact.relativePath}::${fact.declarationId}`;
      const entry = merged.get(key) ?? {
        relativePath: fact.relativePath,
        declarationId: fact.declarationId,
        startLine: null,
        endLine: null,
        parts: [],
        sources: new Map()
      };
      const sourcePath = fact.sourcePath ?? fact.relativePath;
      // 行范围只取声明自身文件里的文档（XML 等其他源文件的行号不属于它）。
      if (sourcePath === fact.relativePath) {
        entry.startLine = entry.startLine == null ? fact.startLine : Math.min(entry.startLine, fact.startLine);
        entry.endLine = entry.endLine == null ? fact.endLine : Math.max(entry.endLine, fact.endLine);
      }
      if (fact.text) entry.parts.push(fact.text);
      entry.sources.set(`${sourcePath}\u0000${fact.contentHash ?? ""}`, { path: sourcePath, contentHash: fact.contentHash });
      merged.set(key, entry);
    }
    return [...merged.values()].map(({ parts, sources, ...row }) => {
      const manifest = [...sources.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return {
        ...row,
        // 空文本只用路径占位；错误信息永远不进入向量文本。
        text: parts.length > 0 ? parts.join("\n") : row.relativePath,
        sources: manifest.map(([, source]) => source),
        sourceManifestHash: sha256(manifest.map(([key]) => key).join("\n"))
      };
    });
  }

  /**
   * R11 dense channel: declaration ids by cosine (ties keep row order, which
   * is deterministic), for RRF fusion. Freshness is the renderer's job.
   */
  rank(queryVector, { topK = 10 } = {}) {
    if (!this.vectors) return [];
    const rows = this.rows ?? this.declarationRows();
    return rows
      .map((row, index) => ({ declarationId: row.declarationId, score: cosine(queryVector, this.vectors[index]), index }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, topK)
      .map(({ declarationId, score }, rank) => ({ declarationId, score, rank: rank + 1 }));
  }

  /**
   * 检索 top-k 提示。hash 能对上（磁盘文件仍等于索引时的 contentHash）才携带
   * indexedContentHash 与行范围；对不上则只给路径，行范围为 null（调用方必须
   * 重读并重新定位，旧行号不可执行）。
   */
  search(queryVector, { topK = 8, minScore = -1 } = {}) {
    if (!this.vectors) return [];
    const rows = this.rows ?? this.declarationRows();
    const scored = rows.map((fact, index) => ({
      fact,
      score: cosine(queryVector, this.vectors[index])
    }));
    return scored
      .filter(entry => entry.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((entry, rank) => {
        const hash = this.hashStillValid(entry.fact);
        const ranged = hash !== undefined && entry.fact.startLine != null;
        return discoveryHint({
          provider: this.provider.provider,
          providerIndexIdentity: this.providerIndexIdentity,
          relativePath: entry.fact.relativePath,
          startLine: ranged ? entry.fact.startLine : null,
          endLine: ranged ? entry.fact.endLine : null,
          rank: rank + 1,
          indexedContentHash: hash
        });
      });
  }

  /**
   * 声明的每个源文件都仍等于索引时的 hash 才算有效；返回声明自身文件的 hash。
   */
  hashStillValid(row) {
    const sources = row.sources ?? [];
    if (sources.length === 0 || sources.some(source => !source.contentHash)) return undefined;
    for (const source of sources) {
      const absolute = path.join(this.repoRoot, source.path);
      try {
        if (!existsSync(absolute) || sha256(readFileSync(absolute, "utf8")) !== source.contentHash) return undefined;
      } catch {
        return undefined;
      }
    }
    return sources.find(source => source.path === row.relativePath)?.contentHash ?? sources[0].contentHash;
  }
}
