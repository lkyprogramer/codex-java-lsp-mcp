import assert from "node:assert/strict";
import test from "node:test";
import { sliceMethod, spansStayInsideMethod, type SliceMethod } from "./statement-slicer.js";

const SOURCE = [
  "class Pay {",
  "  void admit(Order order) {",
  "    validate(order);",
  "    int total = order.sum();",
  "    repository.save(order);",
  "    audit.record(order);",
  "    notify(order);",
  "  }",
  "  void helper() { unused(); }",
  "}"
].join("\n");

const METHOD: SliceMethod = {
  name: "admit",
  startLine: 2,
  endLine: 8,
  bodyStartLine: 2,
  callSites: [
    { line: 3, name: "validate" },
    { line: 5, name: "save" },
    { line: 6, name: "record" },
    { line: 7, name: "notify" }
  ]
};

test("uncertain slice keeps the whole method and never leaves its range", () => {
  const spans = sliceMethod({ method: METHOD, source: SOURCE });
  assert.equal(spans.length, 1);
  assert.equal(spans[0]?.start, 2);
  assert.equal(spans[0]?.end, 8);
  assert.equal(spansStayInsideMethod(spans, METHOD), true);
});

test("related names keep signature plus matching statements, not camelCase fragments", () => {
  const spans = sliceMethod({ method: METHOD, source: SOURCE, relatedNames: ["save"] });
  assert.equal(spansStayInsideMethod(spans, METHOD), true);
  assert.ok(spans.some(span => span.start <= 5 && span.end >= 5));
  const lines = spans.reduce((sum, span) => sum + (span.end - span.start + 1), 0);
  assert.ok(lines < 7, `slice should be smaller than the full method, got ${lines}`);
  const fragment = sliceMethod({ method: METHOD, source: SOURCE, relatedNames: ["sav"] });
  assert.equal(fragment[0]?.start, 2);
  assert.equal(fragment[0]?.end, 8);
});

test("property: random pads never emit spans outside the method", () => {
  for (let index = 0; index < 40; index += 1) {
    const start = 1 + (index % 8);
    const end = start + 3 + (index % 12);
    const method: SliceMethod = {
      name: "m",
      startLine: start,
      endLine: end,
      bodyStartLine: start,
      callSites: [{ line: start + 1, name: "foo" }, { line: end, name: "bar" }]
    };
    const spans = sliceMethod({
      method,
      relatedNames: index % 2 === 0 ? ["foo"] : [],
      source: Array.from({ length: end + 2 }, (_, line) => `L${line} foo bar`).join("\n")
    });
    assert.equal(spansStayInsideMethod(spans, method), true, `case ${index}`);
    assert.ok(spans.every(span => span.start <= span.end));
  }
});
