import assert from "node:assert/strict";
import test from "node:test";
import { closeSearchResult } from "./context-closure.js";
import type { GraphSearchResult } from "./graph-search.js";

function search(): GraphSearchResult {
  return {
    resolvedIntent: "IMPLEMENTATION_CHANGE",
    coverage: "PARTIAL",
    bundles: [
      {
        path: "src/Port.java",
        hops: 0,
        estimatedTokens: 40,
        provingPath: [],
        closedObligations: ["O1"]
      },
      {
        path: "src/Impl.java",
        hops: 1,
        estimatedTokens: 80,
        provingPath: [{ kind: "IMPLEMENTS", fromId: "src/Port.java#Port", toId: "src/Impl.java#Impl" }],
        closedObligations: ["O3"]
      },
      {
        path: "src/Sibling.java",
        hops: 1,
        estimatedTokens: 80,
        provingPath: [{ kind: "CONTAINS", fromId: "src/Port.java", toId: "src" }],
        closedObligations: ["O1"]
      }
    ],
    unresolved: [],
    metrics: { expansions: 3, hops: 1, estimatedTokens: 200 }
  };
}

test("closure keeps the named implementer method whole and drops hop>0 files with no method or type span", () => {
  const bundles = closeSearchResult({
    search: search(),
    anchorLine: 4,
    factsForPath: path => {
      if (path === "src/Port.java") {
        return { methods: [{ name: "getSignedUrl", startLine: 4, endLine: 4 }] };
      }
      if (path === "src/Impl.java") {
        return {
          methods: [
            { name: "getSignedUrl", startLine: 162, endLine: 181 },
            { name: "delete", startLine: 20, endLine: 80 }
          ]
        };
      }
      return { methods: [{ name: "unrelated", startLine: 1, endLine: 40 }] };
    }
  });
  assert.deepEqual(bundles.map(item => item.path).sort(), ["src/Impl.java", "src/Port.java"]);
  const impl = bundles.find(item => item.path === "src/Impl.java")!;
  assert.equal(impl.spans.length, 1);
  assert.equal(impl.spans[0]?.start, 162);
  assert.equal(impl.spans[0]?.end, 181);
  const port = bundles.find(item => item.path === "src/Port.java")!;
  assert.equal(port.spans[0]?.start, 4);
  assert.equal(port.spans[0]?.end, 4);
});

test("hop>0 files with no named method still keep a type span", () => {
  const bundles = closeSearchResult({
    search: {
      resolvedIntent: "CONTRACT_CHANGE",
      coverage: "PARTIAL",
      bundles: [
        { path: "src/Port.java", hops: 0, estimatedTokens: 10, provingPath: [], closedObligations: ["O1"] },
        {
          path: "src/Dto.java",
          hops: 1,
          estimatedTokens: 20,
          provingPath: [{ kind: "IMPORTS", fromId: "src/Port.java#Port", toId: "src/Dto.java#Dto" }],
          closedObligations: ["O5"]
        }
      ],
      unresolved: [],
      metrics: { expansions: 1, hops: 1, estimatedTokens: 30 }
    },
    anchorLine: 4,
    factsForPath: path => path === "src/Port.java"
      ? { methods: [{ name: "getSignedUrl", startLine: 4, endLine: 4 }] }
      : { methods: [], types: [{ start: 1, end: 23 }] }
  });
  const dto = bundles.find(item => item.path === "src/Dto.java");
  assert.ok(dto);
  assert.equal(dto?.spans[0]?.start, 1);
  assert.equal(dto?.spans[0]?.end, 23);
});
