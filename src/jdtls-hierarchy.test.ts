import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { JdtlsSession } from "./jdtls-session.js";
import { DeadlineBudget } from "./runtime/deadline-budget.js";
import {
  deferred,
  fakeTransportFactory,
  type FakeAttemptOptions,
  type FakeJdtlsConnection,
  type FakeJdtlsTransportFactory
} from "./test-support/fake-jdtls.js";

type Harness = {
  session: JdtlsSession;
  factory: FakeJdtlsTransportFactory;
  connection: FakeJdtlsConnection;
  repoRoot: string;
  anchorFile: string;
  outsideFile: string;
};

function hierarchyItem(uri: string, name: string, line = 0): Record<string, unknown> {
  return {
    name,
    kind: 5,
    uri,
    range: { start: { line, character: 0 }, end: { line: line + 4, character: 1 } },
    selectionRange: { start: { line, character: 13 }, end: { line, character: 13 + name.length } }
  };
}

async function harness(attempt: FakeAttemptOptions): Promise<Harness> {
  const scratch = mkdtempSync(path.join(tmpdir(), "jdtls-hierarchy-"));
  const repoRoot = path.join(scratch, "repo");
  const javaDir = path.join(repoRoot, "src", "main", "java", "demo");
  const javaHome = path.join(scratch, "jdk-21");
  mkdirSync(javaDir, { recursive: true });
  mkdirSync(javaHome, { recursive: true });
  const anchorFile = path.join(javaDir, "A.java");
  writeFileSync(anchorFile, "package demo;\npublic class A {}\n", "utf8");
  writeFileSync(path.join(javaDir, "B.java"), "package demo;\npublic class B {}\n", "utf8");
  const outside = mkdtempSync(path.join(tmpdir(), "jdtls-hierarchy-outside-"));
  const outsideFile = path.join(outside, "Library.java");
  writeFileSync(outsideFile, "package org.example;\npublic class Library {}\n", "utf8");

  const previous = { ...process.env };
  process.env.JDTLS_BIN = path.join(scratch, "fake-jdtls");
  process.env.JDTLS_DATA_DIR = path.join(scratch, "workspace");
  process.env.JDTLS_LOG_DIR = path.join(scratch, "logs");
  process.env.JAVA_LSP_PROJECT_JAVA_HOME = javaHome;
  process.env.JDTLS_CACHE_TTL_MS = "0";

  const factory = fakeTransportFactory(attempt);
  const session = new JdtlsSession(repoRoot, [], factory);

  for (const key of ["JDTLS_BIN", "JDTLS_DATA_DIR", "JDTLS_LOG_DIR", "JAVA_LSP_PROJECT_JAVA_HOME", "JDTLS_CACHE_TTL_MS"]) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }

  await session.ensureStarted(DeadlineBudget.fromTimeout(5000));
  return { session, factory, connection: factory.connections[0], repoRoot, anchorFile, outsideFile };
}

test("type hierarchy stops on cycles and does not request the same item twice", async () => {
  const scratchRoot = mkdtempSync(path.join(tmpdir(), "jdtls-cycle-probe-"));
  void scratchRoot;
  let uriA = "";
  let uriB = "";
  const context = await harness({
    handlers: {
      "textDocument/prepareTypeHierarchy": () => [hierarchyItem(uriA, "A")],
      "typeHierarchy/subtypes": (params: unknown) => {
        const item = (params as { item: { uri: string } }).item;
        return item.uri === uriA ? [hierarchyItem(uriB, "B")] : [hierarchyItem(uriA, "A")];
      }
    }
  });
  uriA = pathToFileURL(context.anchorFile).toString();
  uriB = pathToFileURL(path.join(path.dirname(context.anchorFile), "B.java")).toString();

  const result = await context.session.typeHierarchy(
    context.anchorFile,
    1,
    1,
    "subtypes",
    10,
    100,
    DeadlineBudget.fromTimeout(5000)
  );

  assert.equal(result.edges.length, 2);
  assert.equal(context.connection.count("typeHierarchy/subtypes"), 2);
  assert.equal(result.visited, 2);
  assert.equal(result.completion, "COMPLETE");
  await context.session.stop();
});

test("hierarchy items outside the repository never become edges", async () => {
  let uriA = "";
  let outsideUri = "";
  const context = await harness({
    handlers: {
      "textDocument/prepareTypeHierarchy": () => [hierarchyItem(uriA, "A")],
      "typeHierarchy/subtypes": () => [hierarchyItem(outsideUri, "Library")]
    }
  });
  uriA = pathToFileURL(context.anchorFile).toString();
  outsideUri = pathToFileURL(context.outsideFile).toString();

  const result = await context.session.typeHierarchy(
    context.anchorFile,
    1,
    1,
    "subtypes",
    10,
    100,
    DeadlineBudget.fromTimeout(5000)
  );

  assert.equal(result.edges.length, 0);
  assert.equal(JSON.stringify(result).includes("Library.java"), false);
  await context.session.stop();
});

test("an expired hierarchy budget returns partial edges rather than throwing", async () => {
  let uriA = "";
  let uriB = "";
  let nowMs = 0;
  const stall = deferred<unknown>();
  const context = await harness({
    handlers: {
      "textDocument/prepareTypeHierarchy": () => [hierarchyItem(uriA, "A")],
      "typeHierarchy/subtypes": (params: unknown) => {
        const item = (params as { item: { uri: string } }).item;
        // The first expansion answers; the second never settles.
        if (item.uri === uriA) {
          nowMs = 4_999;
          return [hierarchyItem(uriB, "B")];
        }
        return stall.promise;
      }
    }
  });
  uriA = pathToFileURL(context.anchorFile).toString();
  uriB = pathToFileURL(path.join(path.dirname(context.anchorFile), "B.java")).toString();

  const result = await context.session.typeHierarchy(
    context.anchorFile,
    1,
    1,
    "subtypes",
    10,
    100,
    DeadlineBudget.fromTimeout(5_000, () => nowMs)
  );

  assert.equal(result.completion, "PARTIAL_TIMEOUT");
  assert.equal(result.errorCode, "DEADLINE_EXCEEDED");
  assert.equal(result.edges.length, 1, "evidence collected before the deadline is preserved");
  stall.resolve([]);
  await context.session.stop();
});

test("a timed-out prepare returns an empty partial result without traversing", async () => {
  const stall = deferred<unknown>();
  const context = await harness({
    handlers: {
      "textDocument/prepareTypeHierarchy": () => stall.promise,
      "typeHierarchy/subtypes": () => []
    }
  });

  const result = await context.session.typeHierarchy(
    context.anchorFile,
    1,
    1,
    "subtypes",
    10,
    100,
    DeadlineBudget.fromTimeout(150)
  );

  assert.equal(result.completion, "PARTIAL_TIMEOUT");
  assert.deepEqual(result.edges, []);
  assert.equal(result.requests, 0);
  assert.equal(context.connection.count("typeHierarchy/subtypes"), 0);
  stall.resolve([]);
  await context.session.stop();
});

test("the edge limit reports PARTIAL_LIMIT rather than COMPLETE", async () => {
  let uriA = "";
  let uriB = "";
  const context = await harness({
    handlers: {
      "textDocument/prepareTypeHierarchy": () => [hierarchyItem(uriA, "A")],
      "typeHierarchy/subtypes": () => [
        hierarchyItem(uriB, "B", 0),
        hierarchyItem(uriB, "B2", 10),
        hierarchyItem(uriB, "B3", 20)
      ]
    }
  });
  uriA = pathToFileURL(context.anchorFile).toString();
  uriB = pathToFileURL(path.join(path.dirname(context.anchorFile), "B.java")).toString();

  const result = await context.session.typeHierarchy(
    context.anchorFile,
    1,
    1,
    "subtypes",
    10,
    2,
    DeadlineBudget.fromTimeout(5000)
  );

  assert.equal(result.edges.length, 2);
  assert.equal(result.completion, "PARTIAL_LIMIT");
  assert.equal(result.truncated, true);
  await context.session.stop();
});

test("an unexpected JDT error fails the hierarchy with a classified code", async () => {
  let uriA = "";
  const context = await harness({
    handlers: {
      "textDocument/prepareTypeHierarchy": () => [hierarchyItem(uriA, "A")],
      "typeHierarchy/subtypes": () => {
        throw new Error("Internal error in the type hierarchy engine");
      }
    }
  });
  uriA = pathToFileURL(context.anchorFile).toString();

  const result = await context.session.typeHierarchy(
    context.anchorFile,
    1,
    1,
    "subtypes",
    10,
    100,
    DeadlineBudget.fromTimeout(5000)
  );

  assert.equal(result.completion, "FAILED");
  assert.equal(result.errorCode, "JDT_SERVER_ERROR");
  await context.session.stop();
});

test("call hierarchy applies the same visited and containment rules", async () => {
  let uriA = "";
  let uriB = "";
  const context = await harness({
    handlers: {
      "textDocument/prepareCallHierarchy": () => [hierarchyItem(uriA, "A")],
      "callHierarchy/incomingCalls": (params: unknown) => {
        const item = (params as { item: { uri: string } }).item;
        return item.uri === uriA
          ? [{ from: hierarchyItem(uriB, "B"), fromRanges: [] }]
          : [{ from: hierarchyItem(uriA, "A"), fromRanges: [] }];
      }
    }
  });
  uriA = pathToFileURL(context.anchorFile).toString();
  uriB = pathToFileURL(path.join(path.dirname(context.anchorFile), "B.java")).toString();

  const result = await context.session.callHierarchy(
    context.anchorFile,
    1,
    1,
    "incoming",
    10,
    100,
    DeadlineBudget.fromTimeout(5000)
  );

  assert.equal(context.connection.count("callHierarchy/incomingCalls"), 2);
  assert.equal(result.edges.length, 2);
  assert.equal(result.completion, "COMPLETE");
  await context.session.stop();
});

test("a depth limit stops expansion without failing the result", async () => {
  let uriA = "";
  let uriB = "";
  const context = await harness({
    handlers: {
      "textDocument/prepareTypeHierarchy": () => [hierarchyItem(uriA, "A")],
      "typeHierarchy/subtypes": (params: unknown) => {
        const item = (params as { item: { uri: string } }).item;
        return item.uri === uriA ? [hierarchyItem(uriB, "B")] : [];
      }
    }
  });
  uriA = pathToFileURL(context.anchorFile).toString();
  uriB = pathToFileURL(path.join(path.dirname(context.anchorFile), "B.java")).toString();

  const result = await context.session.typeHierarchy(
    context.anchorFile,
    1,
    1,
    "subtypes",
    1,
    100,
    DeadlineBudget.fromTimeout(5000)
  );

  assert.equal(context.connection.count("typeHierarchy/subtypes"), 1, "depth 1 expands only the root");
  assert.equal(result.edges.length, 1);
  await context.session.stop();
});
