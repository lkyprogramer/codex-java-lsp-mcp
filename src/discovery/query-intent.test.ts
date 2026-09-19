import assert from "node:assert/strict";
import test from "node:test";
import { classifyQuery } from "./query-intent.js";

test("T04: a mixed string with class name and natural language is text intent", () => {
  assert.equal(classifyQuery("OrderService rollback refund", "auto"), "text");
  assert.equal(classifyQuery("订单退款", "auto"), "text");
});

test("T04: exact code shapes stay exact in auto mode", () => {
  assert.equal(classifyQuery("demo.OrderService#reverseDuplicateCharge", "auto"), "exact");
  assert.equal(classifyQuery("OrderService", "auto"), "exact", "ASCII PascalCase identifier is a code shape");
  assert.equal(classifyQuery("com.demo.OrderService", "auto"), "exact");
  assert.equal(classifyQuery("OrderService#save(int,String)", "auto"), "exact", "owned parenthesised call is a supported exact shape");
  assert.equal(classifyQuery("OrderService#save(int, String)", "auto"), "text", "whitespace anywhere (even inside parameters) makes the query a description, per the frozen reference");
});

test("T04: plain lowercase English words and CJK default to text in auto mode", () => {
  assert.equal(classifyQuery("rollback", "auto"), "text", "a single plain lowercase word is not a Java identifier shape");
  assert.equal(classifyQuery("结算", "auto"), "text");
  assert.equal(classifyQuery("order service", "auto"), "text");
});

test("T04: explicit mode wins over auto classification", () => {
  assert.equal(classifyQuery("退款", "exact"), "exact");
  assert.equal(classifyQuery("demo.OrderService#save", "text"), "text");
});

test("T04: empty and over-length queries are rejected", () => {
  assert.throws(() => classifyQuery("", "auto"), /query length must be 1\.\.512/);
  assert.throws(() => classifyQuery("   ", "auto"), /query length must be 1\.\.512/);
  assert.throws(() => classifyQuery("a".repeat(513), "auto"), /query length must be 1\.\.512/);
  assert.equal(classifyQuery("a".repeat(512), "exact"), "exact", "512 code units is the boundary, not a rejection");
});

test("T04: complex unsupported generic signatures are not faked into exact in auto mode", () => {
  assert.equal(classifyQuery("Map<String, List<Order>>", "auto"), "text", "angle-bracket generics fall outside the supported exact shapes");
});
