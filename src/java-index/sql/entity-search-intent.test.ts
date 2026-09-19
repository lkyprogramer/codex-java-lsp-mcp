import assert from "node:assert/strict";
import test from "node:test";
import { close, openIndexDb } from "./driver.js";
import { ensureSchema } from "./schema.js";
import { replaceAllEntities } from "./entity-tokens.js";
import { SqlEntitySearch } from "./entity-search.js";

// The C2 fixture at product level: a type and a method of the same owner.
// identifier tokens describe names only; chunk tokens carry body/comment words.
const RECORDS = [
  {
    entityId: "type:demo.OrderService",
    kind: "type" as const,
    fqn: "demo.OrderService",
    simpleName: "OrderService",
    relativePath: "OrderService.java",
    identifierTokens: ["order", "service"],
    chunkTokens: ["accept"]
  },
  {
    entityId: "method:demo.OrderService#reverseDuplicateCharge",
    kind: "method" as const,
    fqn: "demo.OrderService#reverseDuplicateCharge",
    simpleName: "reverseDuplicateCharge",
    relativePath: "OrderService.java",
    identifierTokens: ["reverse", "duplicate", "charge"],
    chunkTokens: ["rollback", "refund"]
  }
];

function searchDb(): Parameters<typeof replaceAllEntities>[0] {
  const db = openIndexDb(":memory:");
  ensureSchema(db);
  replaceAllEntities(db, RECORDS);
  return db;
}

test("T04: a mixed query surfaces the relevant method instead of short-circuiting on the type", () => {
  const db = searchDb();
  try {
    const hits = new SqlEntitySearch(db).search("OrderService rollback refund", 10);
    assert.ok(hits.some(hit => hit.kind === "method"), `a method must compete in a mixed query, got ${JSON.stringify(hits.map(h => [h.simpleName, h.layer]))}`);
  } finally {
    close(db);
  }
});

test("T04: exact owner#method still hits deterministically without the text route", () => {
  const db = searchDb();
  try {
    const hits = new SqlEntitySearch(db).search("demo.OrderService#reverseDuplicateCharge", 10);
    assert.ok(hits.length > 0, "an exact FQN query must not be empty");
    assert.ok(hits.every(hit => hit.layer === "FQN"), `exact route stays FQN-layered, got ${JSON.stringify(hits.map(h => h.layer))}`);
  } finally {
    close(db);
  }
});

test("T04: pure chunk words behave as before (text route)", () => {
  const db = searchDb();
  try {
    const hits = new SqlEntitySearch(db).search("rollback refund", 10);
    assert.ok(hits.some(hit => hit.kind === "method"), `chunk words must reach the method, got ${JSON.stringify(hits.map(h => [h.simpleName, h.layer]))}`);
  } finally {
    close(db);
  }
});

test("T04: explicit text mode never short-circuits on an FQN layer", () => {
  const db = searchDb();
  try {
    const hits = new SqlEntitySearch(db).search("OrderService", 10, "text");
    assert.ok(hits.every(hit => hit.layer !== "FQN"), `explicit text must not return FQN-layer hits, got ${JSON.stringify(hits.map(h => h.layer))}`);
  } finally {
    close(db);
  }
});

test("T04: explicit exact mode keeps the legacy layered chain", () => {
  const db = searchDb();
  try {
    const hits = new SqlEntitySearch(db).search("OrderService", 10, "exact");
    assert.ok(hits.length > 0 && hits.every(hit => hit.layer === "SIMPLE_NAME" || hit.layer === "FQN"), `exact mode keeps name layers, got ${JSON.stringify(hits.map(h => h.layer))}`);
  } finally {
    close(db);
  }
});
