// input:  T10 可选语义发现实验 - 独立包，不进产品依赖树（stock 外部向量路线）。
//         一个 OpenRouter 兼容 embedding provider（液金 350M，1024 维），
//         对 SearchDocument 对齐的文本做 dense 索引与检索，产出 DISCOVERY_HINT。
// output: DiscoveryHint[]（provider/index 身份、路径、行范围、rank、可得 contentHash）；
//         provider 故障/超时/离线/无授权安静返回空提示，调用方回退 A2，不重试风暴。
// pos:    docs/10 阶段 Z1/Z2 - 相似性证据只标 DISCOVERY_HINT，绝不标 JDT_BOUND；
//         无 indexedContentHash 时调用方必须重读并重新定位声明，不承认旧行号。
// 授权:   用户显式提供 OpenRouter key（仓库外存储）并授权网络与免费 embedding 推理。
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const HINT_AUTHORITY = "DISCOVERY_HINT";
export const EMBEDDING_DIM = 1024;

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
 * OpenRouter 兼容 embedding 客户端。批量优先；超时用 AbortController；
 * 任何失败抛 EmbeddingProviderError，由调用方决定安静回退（本包内不重试风暴，
 * 仅对 429/5xx 做有限退避，最多 maxRetries 次）。
 */
export class EmbeddingProvider {
  constructor({ apiKey, model, baseUrl = "https://openrouter.ai/api/v1", fetchImpl = globalThis.fetch, timeoutMs = 30_000, maxRetries = 2 }) {
    if (!apiKey) throw new Error("EMBEDDING_NOT_AUTHORIZED: no API key");
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.calls = 0;
    this.batchCalls = 0;
    this.itemsEmbedded = 0;
    this.errors = 0;
    this.latencyMs = 0;
  }

  get provider() {
    return "openrouter";
  }

  async embed(texts) {
    if (!Array.isArray(texts) || texts.length === 0) return [];
    const vectorByIndex = new Map();
    for (let i = 0; i < texts.length; i += 16) {
      const batch = texts.slice(i, i + 16);
      const vector = await this.embedBatch(batch);
      for (let j = 0; j < batch.length; j += 1) {
        vectorByIndex.set(i + j, vector[j]);
      }
    }
    return texts.map((_, index) => vectorByIndex.get(index));
  }

  async embedBatch(batch) {
    let attempt = 0;
    for (;;) {
      const started = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        this.calls += 1;
        this.batchCalls += 1;
        const response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ model: this.model, input: batch, encoding_format: "float" }),
          signal: controller.signal
        });
        clearTimeout(timer);
        this.latencyMs += Date.now() - started;
        if (!response.ok) {
          const body = (await response.text().catch(() => "")).slice(0, 200);
          if ((response.status === 429 || response.status >= 500) && attempt < this.maxRetries) {
            attempt += 1;
            await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
            continue;
          }
          throw new EmbeddingProviderError(`embedding HTTP ${response.status}: ${body}`);
        }
        const data = await response.json();
        const rows = data.data ?? [];
        const ordered = rows
          .slice()
          .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
          .map(row => row.embedding);
        if (ordered.length !== batch.length || ordered.some(v => !Array.isArray(v) || v.length !== EMBEDDING_DIM)) {
          throw new EmbeddingProviderError(`embedding shape mismatch: got ${ordered.length} rows`);
        }
        this.itemsEmbedded += batch.length;
        return ordered;
      } catch (error) {
        this.errors += 1;
        if (error instanceof EmbeddingProviderError && attempt >= this.maxRetries) throw error;
        if (error instanceof EmbeddingProviderError) {
          const retryable = /HTTP 429|HTTP 5\d\d/.test(error.message);
          if (retryable && attempt < this.maxRetries) {
            attempt += 1;
            await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
            continue;
          }
          throw error;
        }
        throw new EmbeddingProviderError(error instanceof Error ? error.message : String(error));
      }
    }
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

export class EmbeddingProviderError extends Error {
  constructor(message) {
    super(message);
    this.name = "EmbeddingProviderError";
  }
}

/**
 * 从产品 SQL 索引读取 SearchDocument 对齐的声明文本（signature/identifier/
 * comment/framework 文档拼在声明上），产出 dense 行。文档层是 T05 建立的，
 * 这里只是实验侧读法，不改产品。
 */
export function readSearchDocumentFacts(repoRoot, dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const docs = db
      .prepare(
        `SELECT d.sym AS docId, p.text AS relativePath, d.start_line AS startLine, d.end_line AS endLine,
                d.kind, d.content_hash AS contentHash, s.text AS declarationId
         FROM search_doc d
         LEFT JOIN sym p ON p.id = d.path_sym
         LEFT JOIN sym s ON s.id = d.declaration_sym`
      )
      .all();
    const tokens = db.prepare("SELECT doc_sym, t.text, tf FROM search_doc_token tok JOIN sym t ON t.id = tok.token_sym").all();
    const tokensByDoc = new Map();
    for (const token of tokens) {
      const list = tokensByDoc.get(token.doc_sym) ?? [];
      list.push(token.text);
      tokensByDoc.set(token.doc_sym, list);
    }
    return docs.map(doc => ({
      docId: doc.docId,
      relativePath: doc.relativePath ?? "unknown",
      startLine: doc.startLine,
      endLine: doc.endLine,
      kind: doc.kind,
      contentHash: doc.contentHash,
      declarationId: doc.declarationId ?? "",
      text: (tokensByDoc.get(doc.docId) ?? []).join(" ")
    }));
  } finally {
    db.close();
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

/**
 * 对齐表示的 dense 索引：与 A2 共用同一 SearchDocument 文本面，归因才有效
 * （docs/10："能够对齐表示时，比较同一 SearchDocument 上的 lexical/dense/RRF"）。
 */
export class DenseDiscoveryIndex {
  constructor({ provider, facts, corpusHash, repoRoot }) {
    this.provider = provider;
    this.facts = facts;
    this.corpusHash = corpusHash;
    this.repoRoot = repoRoot;
    this.vectors = null;
    this.buildCost = null;
    this.indexedAt = null;
  }

  get providerIndexIdentity() {
    return `openrouter:${this.provider.model}:dim${EMBEDDING_DIM}:${this.corpusHash.slice(0, 12)}`;
  }

  async build() {
    // 每个声明归并其全部文档文本，一次 embed，行与事实一一对应。
    const rows = this.declarationRows();
    const texts = rows.map(row => (row.text.join(" ").length > 0 ? row.text.join(" ") : row.relativePath));
    const costBefore = { ...this.provider.costReport() };
    const startedAt = Date.now();
    const vectors = await this.provider.embed(texts);
    this.buildCost = {
      ...this.provider.costReport(),
      deltaHttpCalls: this.provider.calls - costBefore.calls,
      deltaItemsEmbedded: this.provider.itemsEmbedded - costBefore.itemsEmbedded,
      deltaLatencyMs: this.provider.latencyMs - costBefore.latencyMs,
      wallMs: Date.now() - startedAt
    };
    this.vectors = vectors;
    this.indexedAt = new Date().toISOString();
    return rows.length;
  }

  /** 全部事实按 (path, declarationId) 归并；Map 保持插入序，search 依赖同一行序。 */
  declarationRows() {
    const merged = new Map();
    for (const fact of this.facts) {
      const key = `${fact.relativePath}::${fact.declarationId}`;
      const entry = merged.get(key) ?? {
        relativePath: fact.relativePath,
        declarationId: fact.declarationId,
        startLine: fact.startLine,
        endLine: fact.endLine,
        contentHash: fact.contentHash,
        text: []
      };
      entry.startLine = Math.min(entry.startLine, fact.startLine);
      entry.endLine = Math.max(entry.endLine, fact.endLine);
      if (fact.contentHash) entry.contentHash = fact.contentHash;
      if (fact.text) entry.text.push(fact.text);
      merged.set(key, entry);
    }
    return [...merged.values()];
  }

  /**
   * 检索 top-k 提示。hash 能对上（磁盘文件仍等于索引时的 contentHash）才携带
   * indexedContentHash；对不上则只给路径（调用方必须重读重定位，不承认旧行号）。
   */
  search(queryVector, { topK = 8, minScore = -1 } = {}) {
    if (!this.vectors) return [];
    const rows = this.declarationRows();
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
        return discoveryHint({
          provider: this.provider.provider,
          providerIndexIdentity: this.providerIndexIdentity,
          relativePath: entry.fact.relativePath,
          startLine: entry.fact.startLine,
          endLine: entry.fact.endLine,
          rank: rank + 1,
          indexedContentHash: hash
        });
      });
  }

  hashStillValid(fact) {
    if (!fact.contentHash) return undefined;
    const absolute = path.join(this.repoRoot, fact.relativePath);
    if (!existsSync(absolute)) return undefined;
    try {
      const content = readFileSync(absolute, "utf8");
      return createHash("sha256").update(content, "utf8").digest("hex") === fact.contentHash
        ? fact.contentHash
        : undefined;
    } catch {
      return undefined;
    }
  }
}