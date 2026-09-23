// input:  查询意图（与 A2 的 classifyQuery 对齐的纯函数副本）、dense 索引、
//         已知 anchor 路径集合。
// output: Z2 门控 —— exact/position/已知 anchor 任务不发 embedding；provider
//         故障/超时/未授权/离线安静回退 A2（返回 {hints:[], fallback:"A2"}），
//         不无限重试；结果只含 DISCOVERY_HINT，绝不升级绑定等级。
// pos:    docs/10 阶段 Z2；K27（离线/timeout/hash 不一致强制退回 A2）。
import { HINT_AUTHORITY } from "./provider.mjs";

// 与 src/discovery/query-intent.ts 的 CODE_SHAPE 保持同形（实验侧独立副本，
// 避免实验包导入产品源码树）。
const CODE_SHAPE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:[.$][A-Za-z_$][A-Za-z0-9_$]*)*(?:#[A-Za-z_$][A-Za-z0-9_$]*(?:\([^()]*\))?)?$/;

export function classifyQueryIntent(raw, mode = "auto") {
  const q = String(raw ?? "").trim();
  if (!q || q.length > 512) return "invalid";
  if (mode !== "auto") return mode;
  if (/\s/.test(q) || /[\u3400-\u9fff]/.test(q)) return "text";
  if (!CODE_SHAPE.test(q)) return "text";
  return /[.#()]/.test(q) || /[A-Z]/.test(q) ? "exact" : "text";
}

export function shouldRunDense({ query, intent, knownAnchorPaths = [] }) {
  const resolved = intent ?? classifyQueryIntent(query);
  if (resolved === "exact" || resolved === "invalid") return { run: false, reason: resolved === "exact" ? "exact_not_embedded" : "invalid_query" };
  const q = String(query ?? "").trim().toLowerCase();
  for (const anchorPath of knownAnchorPaths) {
    const base = String(anchorPath).split("/").pop() ?? "";
    if (base && (q === base.toLowerCase() || q === String(anchorPath).toLowerCase())) {
      return { run: false, reason: "known_anchor_not_embedded" };
    }
  }
  return { run: true, reason: "text_intent" };
}

/**
 * 受门控的 dense 检索：任何异常（未授权、离线、超时、模型缺失）都安静降级，
 * 调用方继续用 A2 结果，记录 fallback 原因供实验报告。
 */
export async function gatedDenseSearch({ query, index, provider, queryEmbed, knownAnchorPaths = [], topK = 8 }) {
  const gate = shouldRunDense({ query, knownAnchorPaths });
  if (!gate.run) {
    return { hints: [], fallback: "A2", reason: gate.reason, embeddedQueries: 0 };
  }
  try {
    if (!index?.vectors) {
      return { hints: [], fallback: "A2", reason: "index_unavailable", embeddedQueries: 0 };
    }
    const vectors = await (queryEmbed ?? provider?.embed?.bind(provider))?.([query]) ?? [];
    const vector = vectors[0];
    if (!Array.isArray(vector)) {
      return { hints: [], fallback: "A2", reason: "embedding_failed", embeddedQueries: 1 };
    }
    const hints = index.search(vector, { topK });
    for (const hint of hints) {
      if (hint.authority !== HINT_AUTHORITY) {
        return { hints: [], fallback: "A2", reason: "authority_violation", embeddedQueries: 1 };
      }
    }
    return { hints, fallback: hints.length > 0 ? "NONE" : "A2", reason: "ok", embeddedQueries: 1 };
  } catch {
    // K27: offline/timeout/model-missing -> A2, no retry storm.
    return { hints: [], fallback: "A2", reason: "provider_error", embeddedQueries: 0 };
  }
}