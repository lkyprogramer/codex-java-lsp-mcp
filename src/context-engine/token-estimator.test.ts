import assert from "node:assert/strict";
import test from "node:test";
import { BYTES_DIV_4, estimateSpanBytes, estimateTokens, type Tokenizer } from "./token-estimator.js";

const utf8Div4: Tokenizer = {
  id: "utf8-chars/4",
  estimateTokens(text: string): number {
    return Math.ceil([...text].length / 4);
  }
};

function payload(index: number): string {
  return JSON.stringify({
    version: 1,
    target: { file: `src/mod${index}/Service${index}.java`, symbol: `run${index}` },
    contexts: Array.from({ length: 3 + (index % 4) }, (_, inner) => ({
      path: `src/mod${index}/Collab${inner}.java`,
      role: "COL",
      proof: ["CALLS_EXACT"],
      spans: [{ s: 10, e: 20 + inner, b: 80 + inner * 12 }]
    })),
    unresolved: [],
    cost: { modelTokens: 100 + index, serviceMs: 12 }
  });
}

test("default estimator is bytes/4 and accepts an injected tokenizer", () => {
  const text = "abcd";
  assert.equal(estimateTokens(text), 1);
  assert.equal(BYTES_DIV_4.id, "bytes/4");
  const injected: Tokenizer = { id: "fixed", estimateTokens: () => 7 };
  assert.equal(estimateTokens(text, injected), 7);
});

test("twenty compact-shaped payloads stay within 15% of an injected unicode/4 tokenizer", () => {
  for (let index = 0; index < 20; index += 1) {
    const text = payload(index);
    const fallback = estimateTokens(text);
    const injected = estimateTokens(text, utf8Div4);
    const denom = Math.max(fallback, injected, 1);
    const delta = Math.abs(fallback - injected) / denom;
    assert.ok(delta <= 0.15, `payload ${index} delta ${delta} fallback ${fallback} injected ${injected}`);
  }
});

test("span byte fallback scales with line count and uses source when present", () => {
  assert.equal(estimateSpanBytes(1, 2), 96);
  assert.equal(estimateSpanBytes(1, 1, "abc"), 3);
});
