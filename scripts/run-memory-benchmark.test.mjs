import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  attributeBundles,
  bytesToMiB,
  classifyFactValue,
  concurrentRuntimePlan,
  g5SteadyRatio,
  M0_GATES,
  M0_WARM_P95_MS,
  parseMemoryBenchmarkCli,
  percentile,
  sampleEven,
  splitWarmLatencies,
  unmeasuredScenario
} from "./run-memory-benchmark.mjs";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "run-memory-benchmark.mjs");

test("parseMemoryBenchmarkCli accepts three-repo flags and boolean skip", () => {
  const cli = parseMemoryBenchmarkCli([
    "--lishuedu", "/tmp/l",
    "--cipherlink", "/tmp/c",
    "--exam-parent-v3", "/tmp/e",
    "--output", "{state}/m0.json",
    "--skip-concurrent",
    "--timeout-ms", "120000"
  ]);
  assert.equal(cli.skipConcurrent, true);
  assert.equal(cli.timeoutMs, 120_000);
  assert.equal(cli.mode, "project");
  assert.equal(cli.repositories.lishuedu, "/tmp/l");
});

test("percentile uses the ceiling rank and bytesToMiB rounds", () => {
  assert.equal(percentile([], 95), 0);
  assert.equal(percentile([10], 95), 10);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(bytesToMiB(2 * 1024 * 1024), 2);
});

test("sampleEven keeps order and covers both ends", () => {
  assert.deepEqual(sampleEven([1, 2, 3], 10), [1, 2, 3]);
  assert.deepEqual(sampleEven([0, 1, 2, 3, 4, 5, 6, 7], 4), [0, 2, 4, 6]);
});

test("classifyFactValue names the five object-model heads", () => {
  assert.equal(classifyFactValue({ start: { line: 1, column: 1 }, end: { line: 2, column: 1 } }), "SourceRange");
  assert.equal(classifyFactValue({ line: 1, column: 2 }), "SourcePoint");
  assert.equal(classifyFactValue({ edgeId: "e", fromId: "a", toId: "b" }), "StaticEdge");
  assert.equal(classifyFactValue({
    kind: "METHOD_INVOCATION",
    name: "save",
    arity: 1,
    argumentTypeHints: [],
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } }
  }), "JavaCallSiteFact");
  assert.equal(classifyFactValue({
    text: "Foo",
    simpleName: "Foo",
    typeArguments: [],
    arrayDepth: 0,
    resolution: { state: "UNRESOLVED" }
  }), "JavaTypeRef");
});

test("attributeBundles reports string duplication and constructor counts", () => {
  const range = () => ({ start: { line: 1, column: 1 }, end: { line: 1, column: 8 } });
  const typeRef = {
    text: "PayAccount",
    simpleName: "PayAccount",
    typeArguments: [],
    arrayDepth: 0,
    resolution: { state: "RESOLVED_REPO", typeId: "file#PayAccount#type#abcd", strategy: "QUALIFIED" }
  };
  const attributed = attributeBundles([
    {
      file: { relativePath: "a.java", contentHash: "h", imports: [] },
      types: [],
      fields: [],
      methods: [{
        methodId: "file#PayAccount#save#abcd",
        ownerTypeId: "file#PayAccount#type#abcd",
        name: "save",
        constructor: false,
        signatureKey: "save()",
        range: range(),
        modifiers: [],
        annotations: [],
        typeParameters: [],
        parameters: [],
        throws: [],
        callSites: [{
          kind: "METHOD_INVOCATION",
          name: "insert",
          arity: 1,
          argumentTypeHints: [typeRef],
          range: range()
        }],
        localTypes: []
      }],
      edges: [{
        edgeId: "e1",
        fromId: "file#PayAccount#save#abcd",
        toId: "file#PayAccount#type#abcd",
        kind: "CALLS",
        confidence: 1,
        sourceFile: "a.java",
        generation: 1,
        resolution: { kind: "AST_EXPLICIT" },
        range: range()
      }]
    }
  ]);
  assert.equal(attributed.constructors.JavaCallSiteFact, 1);
  assert.equal(attributed.constructors.JavaTypeRef, 1);
  assert.equal(attributed.constructors.StaticEdge, 1);
  assert.equal(attributed.constructors.SourceRange >= 2, true);
  assert.equal(attributed.stringBytes > attributed.uniqueStringBytes, true);
  assert.equal(attributed.shares.strings > 0, true);
  assert.equal(attributed.estimatedBytes, attributed.stringBytes + attributed.objectHeaderBytes + attributed.arrayBytes);
});

test("concurrentRuntimePlan is 3 then 5 runtimes; UNMEASURED keeps a reason", () => {
  const plan = concurrentRuntimePlan();
  assert.equal(plan.S1.length, 3);
  assert.equal(plan.S2.length, 5);
  assert.equal(M0_GATES.S4_HIBERNATE_HEAP_MIB, 32);
  assert.equal(M0_GATES.G5_FIRST_HYDRATE_MS, 2000);
  assert.equal(plan.S2.filter(item => item.worktree).length, 2);
  const missing = unmeasuredScenario("S1", "OOM");
  assert.equal(missing.status, "UNMEASURED");
  assert.equal(missing.rssDeltaBytes, null);
});

test("splitWarmLatencies isolates first hydrate from steady warm p95", () => {
  const split = splitWarmLatencies([7704.37, 59.56, 69.88, 43.84, 42.89, 46.09, 34.48, 36.75, 50.19, 44.69]);
  assert.equal(split.scenarios, 10);
  assert.equal(split.steadyScenarios, 9);
  assert.equal(split.firstHydrateMs, 7704.37);
  assert.equal(split.p95Ms, 7704.37);
  assert.equal(split.steadyWarmP95Ms, 69.88);
  assert.ok(split.steadyWarmP95Ms < 80);
  const empty = splitWarmLatencies([]);
  assert.equal(empty.firstHydrateMs, 0);
  assert.equal(empty.steadyWarmP95Ms, 0);
});

test("G5 steady ratio uses M0 p95, not the first hydrate sample", () => {
  assert.equal(M0_WARM_P95_MS.lishuedu, 77.2);
  const contaminated = g5SteadyRatio("lishuedu", 7704.37);
  const steady = g5SteadyRatio("lishuedu", 69.88);
  assert.ok(contaminated > M0_GATES.G5_P95_RATIO);
  assert.ok(steady <= M0_GATES.G5_P95_RATIO);
  assert.equal(g5SteadyRatio("unknown-repo", 10), null);
});

test("run-memory-benchmark refuses to run outside isolated validation", async () => {
  const blocked = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      script,
      "--lishuedu", "/tmp/l",
      "--cipherlink", "/tmp/c",
      "--exam-parent-v3", "/tmp/e",
      "--output", "/tmp/out.json"
    ], {
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "JAVA_LSP_ISOLATED_VALIDATION")),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stderr = [];
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", code => resolve({ code, stderr: Buffer.concat(stderr).toString("utf8") }));
  });
  assert.notEqual(blocked.code, 0);
  assert.match(blocked.stderr, /isolated validation/);
});
