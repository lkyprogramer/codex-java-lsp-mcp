import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { stripJava, hierarchyOf } from "./ilv2-relation-text-check.mjs";
import { IMPACT_ARGS, callShape, hypotheses, implementationShape, moduleOf, outcomeOf, reproduction, runDefectShape, subtypeCounts, summarize, typeIndexOf } from "./ilv2-relation-defect-shape.mjs";

const SOURCES = {
  "core/src/main/java/demo/PriceRule.java": "public interface PriceRule {}",
  "core/src/main/java/demo/BaseRule.java": "public abstract class BaseRule<T> implements PriceRule {}",
  "core/src/main/java/demo/Calc.java": "public class Calc implements Clamp { public static int clamp(int v) { return v; } public int twice(int v) { return v; } }",
  "core/src/main/java/demo/Clamp.java": "public interface Clamp {}"
};
const files = Object.entries(SOURCES).map(([file, text]) => ({ path: file, text }));
const index = typeIndexOf(files);
const graph = hierarchyOf(files.map(file => file.text));
const lines = text => stripJava(text).split("\n");
const decl = (kind, name, fqn, relativePath) => ({ kind, name, fqn, relativePath, selection: { line: 1, column: 1 } });

test("module and type kinds", () => {
  assert.equal(moduleOf("core/src/main/java/demo/A.java"), "core");
  assert.equal(moduleOf("src/main/java/A.java"), "");
  assert.deepEqual(index.get("BaseRule").map(entry => [entry.keyword, entry.abstract]), [["class", true]]);
});

test("implementation shape: anchor kind, clause, generics and the first hop", () => {
  const ruleAnchor = decl("type", "PriceRule", "demo.PriceRule", "core/src/main/java/demo/PriceRule.java");
  assert.deepEqual(implementationShape({ anchor: ruleAnchor, link: { linkClass: "DIRECT", depth: 1 }, lines: lines("class Vip implements PriceRule {}"), index, graph }),
    { anchorKind: "interface", anchorDeclaredIn: "corpus", directSubtypes: 1, transitiveSubtypes: 1, overImplementerLimit: false, clause: "implements", genericArgs: false });
  const baseAnchor = decl("type", "BaseRule", "demo.BaseRule", "core/src/main/java/demo/BaseRule.java");
  assert.deepEqual(implementationShape({ anchor: baseAnchor, link: { linkClass: "DIRECT", depth: 1 }, lines: lines("class Vip extends BaseRule<String> {}"), index, graph }),
    { anchorKind: "abstract-class", anchorDeclaredIn: "corpus", directSubtypes: 0, transitiveSubtypes: 0, overImplementerLimit: false, clause: "extends", genericArgs: true });
  assert.deepEqual(implementationShape({ anchor: ruleAnchor, link: { linkClass: "INDIRECT", depth: 2 }, lines: lines("class Vip extends BaseRule<String> {}"), index, graph }),
    { anchorKind: "interface", anchorDeclaredIn: "corpus", directSubtypes: 1, transitiveSubtypes: 1, overImplementerLimit: false, clause: "extends", genericArgs: true, viaKind: "abstract-class", viaSameModuleAsAnchor: true });
  const wide = hierarchyOf(Array.from({ length: 21 }, (_, i) => `class Impl${i} implements Wide {}`).concat(["class Deep extends Impl0 {}"]));
  assert.deepEqual(subtypeCounts(wide, "Wide"), { directSubtypes: 21, transitiveSubtypes: 22, overImplementerLimit: true });
});

test("call shape: receiver forms and the receiver's declared type", () => {
  const clamp = decl("method", "clamp", "demo.Calc#clamp", "core/src/main/java/demo/Calc.java");
  const shape = (body, start = 2, end = 2) => callShape({ anchor: clamp, item: { startLine: start, endLine: end }, lines: lines(body), index, graph });
  assert.deepEqual(shape("class Y {\n int a() { return Calc.clamp(1); }\n}"), { ownerKind: "class", receiver: "static-owner", receiverType: null });
  assert.equal(shape("class Y {\n int a() { return clamp(1); }\n}").receiver, "unqualified");
  assert.equal(shape("class Y {\n int a() { return make().clamp(1); }\n}").receiver, "chained");
  assert.equal(shape("class Y {\n int a() { return this.clamp(1); }\n}").receiver, "this");
  assert.deepEqual(shape("class Y { private Calc calc;\n int a() { return calc.clamp(1); }\n}"), { ownerKind: "class", receiver: "variable", receiverType: "owner" });
  assert.deepEqual(shape("class Y { private Clamp calc;\n int a() { return calc.clamp(1); }\n}"), { ownerKind: "class", receiver: "variable", receiverType: "supertype-of-owner:interface" });
  assert.equal(shape("class Y {\n int a() { return calc.clamp(1); }\n}").receiverType, "undeclared");
  assert.equal(shape("class Y {\n int a() { return 1; }\n}").receiver, "none");
});

test("reproduction keeps allow-listed reason kinds, counts the rest, and reports pool-wide relation kinds", () => {
  const item = { path: "core/src/main/java/demo/Vip.java" };
  const diagnostic = { status: "OK", target: { profile: "dto" }, freshness: { coverage: "COMPLETE" }, evidenceGaps: ["Protected core exceeded read-plan limits (4)"],
    files: [{ id: "f1", path: item.path, reasons: ["typeGraph", "rg:SecretName", "PriceRule"] }, { id: "f2", path: "x.java", reasons: ["CALLS", "typeGraph"] }], readPlan: [] };
  assert.deepEqual(reproduction(diagnostic, item), { status: "OK", anchorProfile: "dto", coverage: "COMPLETE", coreExceeded: true, poolSize: 2,
    poolWith: { typeGraph: 2, "typeGraph:implementation-lookup": 0, IMPLEMENTS: 0, CALLS: 1, METHOD_RELATION: 0 },
    inPool: true, selected: false, protectedReason: false, reasonKinds: ["typeGraph"], otherReasons: 2, reproduced: true });
  assert.equal(reproduction({ files: [{ id: "f1", path: item.path, reasons: ["typeGraph:implementation-lookup"] }], readPlan: [{ fileId: "f1" }] }, item).reproduced, false);
  assert.equal(reproduction({ files: [] }, item).inPool, false);
});

test("hypotheses, outcomes and the summary", () => {
  const impl = (anchorKind, profile, extra = {}) => ({ category: "implementations", cause: "WEAK_RELATION", linkClass: "DIRECT", shape: { anchorKind, overImplementerLimit: false }, sameModule: true, testSource: false,
    repro: { reproduced: true, anchorProfile: profile, reasonKinds: [] }, ...extra });
  assert.deepEqual(hypotheses(impl("abstract-class", "dto")), ["H1_TYPEGRAPH_GATED"]);
  assert.deepEqual(hypotheses(impl("abstract-class", "service", { repro: { reproduced: true, anchorProfile: "service", reasonKinds: ["typeGraph"] } })), ["H2_NON_INTERFACE_WEAK"]);
  assert.deepEqual(hypotheses(impl("interface", "port", { linkClass: "INDIRECT" })), ["H3_ONE_HOP"]);
  assert.deepEqual(hypotheses(impl("interface", "port")), ["H0_UNEXPLAINED"]);
  assert.deepEqual(hypotheses(impl("interface", "port", { shape: { anchorKind: "interface", overImplementerLimit: true } })), ["H_CAP"]);
  assert.deepEqual(hypotheses(impl("unknown", "dto")), ["H_UNKNOWN_ANCHOR"], "an unresolved anchor kind is not H1/H2");
  assert.deepEqual(hypotheses(impl("interface", "port", { repro: { reproduced: false } })), []);
  assert.deepEqual(hypotheses(impl("interface", "port", { repro: { callFailed: true } })), []);
  const caller = (receiver, receiverType = "owner") => ({ category: "callers", cause: "WEAK_RELATION", linkClass: "DIRECT", shape: { receiver, receiverType }, repro: { reproduced: true, reasonKinds: [] } });
  assert.deepEqual(hypotheses(caller("static-owner", null)), ["C_OWNER_BOUND"]);
  assert.deepEqual(hypotheses(caller("variable", "supertype-of-owner:interface")), ["C_OVERRIDE_FAMILY"]);
  assert.deepEqual(hypotheses(caller("chained", null)), ["C_OTHER:chained/-"]);
  assert.deepEqual(["H0_UNEXPLAINED", "C_OWNER_BOUND", "H1_TYPEGRAPH_GATED", "H3_ONE_HOP", "C_OTHER:chained/-"].map(outcomeOf), ["defect", "defect", "test-then-user", "user", "user"]);
  const summary = summarize([impl("abstract-class", "dto"), impl("interface", "port", { repro: { reproduced: false } }), impl("interface", "port", { repro: { callFailed: true } }),
    caller("variable"), caller("chained", null)]);
  assert.deepEqual([summary.targets, summary.callFailed, summary.reproduced, summary.reproGate.passed], [5, 1, 3, true]);
  assert.deepEqual(summary.byOutcome, { "test-then-user": { H1_TYPEGRAPH_GATED: 1 }, defect: { C_OWNER_BOUND: 1 }, user: { "C_OTHER:chained/-": 1 } });
  assert.equal(summary.shapes.length, 5);
  assert.equal(summarize([impl("interface", "port", { repro: { reproduced: false } })]).reproGate.passed, false);
});

test("the run calls java_impact once per linked target with the D15-F policy and keeps names out of the summary", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "d18-"));
  try {
    const hash = text => createHash("sha256").update(text).digest("hex");
    const target = { path: "app/src/main/java/demo/VipRule.java", startLine: 1, endLine: 1 };
    const anchor = decl("type", "PriceRule", "demo.PriceRule", "core/src/main/java/demo/PriceRule.java");
    const tasks = `${JSON.stringify({ taskId: "t1", corpusId: "c1", category: "implementations" })}\n`;
    const gold = `${JSON.stringify({ taskId: "t1", requiredEvidence: [target] })}\n`;
    const responses = `${JSON.stringify({ taskId: "t1", terms: [{ exact: "match", symbol: { candidates: [{ declaration: anchor }] },
      impacts: { C0: { diagnostic: { files: [], readPlan: [], evidenceGaps: [] } }, C3: { diagnostic: { files: [], readPlan: [], evidenceGaps: [] } } } }] })}\n`;
    const targets = [{ kind: "java", credited: false, label: "POOL_ABSENT" }];
    const rows = `${JSON.stringify({ taskId: "t1", category: "implementations", configs: { C0: { targets }, C3: { targets } } })}\n`;
    const inputs = JSON.stringify([{ name: "c1", head: "h", manifestSha256: "m", repoRoot: "unused" }]);
    for (const [name, text] of Object.entries({ "tasks.jsonl": tasks, "gold.jsonl": gold, "responses.jsonl": responses, "rows.jsonl": rows, "inputs.json": inputs,
      "corpus.json": JSON.stringify({ corpora: [{ corpusId: "c1", head: "h", inputManifestSha256: "m", overlays: [], evidenceFiles: [] }] }), "build-stamp.json": "{}" })) await writeFile(path.join(dir, name), text);
    const manifest = { datasetId: "fixture", datasetDigest: "d", parts: { "tasks-dev": { sha256: hash(tasks) }, "gold-dev": { sha256: hash(gold) }, corpus: { file: "corpus.json" } } };
    const materialize = async ({ target: root }) => {
      for (const [file, text] of Object.entries({ ...SOURCES, [target.path]: "public class VipRule implements PriceRule {}" })) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), text);
      }
      return root;
    };
    const calls = [];
    const openSession = async () => ({ readyMs: 1, close: async () => {}, call: async (name, args) => {
      calls.push([name, args]);
      return { status: "OK", target: { profile: "port" }, files: [{ id: "f9", path: "core/src/main/java/demo/Other.java", reasons: ["typeGraph"] }], readPlan: [] };
    } });
    const summary = await runDefectShape({ datasetFile: "unused", tasksFile: path.join(dir, "tasks.jsonl"), goldFile: path.join(dir, "gold.jsonl"), inputsFile: path.join(dir, "inputs.json"),
      serverJs: path.join(dir, "server.js"), responsesFile: path.join(dir, "responses.jsonl"), rowsFile: path.join(dir, "rows.jsonl"), out: path.join(dir, "out"),
      expect: { responses: hash(responses), rows: hash(rows) }, verify: async () => ({ root: dir, manifest }), materialize, openSession });
    assert.deepEqual(calls, [["java_impact", { file: anchor.relativePath, line: 1, column: 1, ...IMPACT_ARGS }]]);
    assert.deepEqual([summary.targets, summary.reproduced, summary.byHypothesis], [1, 1, { H0_UNEXPLAINED: 1 }]);
    assert.deepEqual(summary.shapes[0].shape, { anchorKind: "interface", anchorDeclaredIn: "corpus", directSubtypes: 2, transitiveSubtypes: 2, overImplementerLimit: false, clause: "implements", genericArgs: false });
    assert.equal(summary.shapes[0].sameModule, false);
    assert.match(await readFile(path.join(dir, "out/shape-rows.jsonl"), "utf8"), /VipRule/);
    assert.doesNotMatch(JSON.stringify(summary), /VipRule|PriceRule|demo|core\//);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a failed impact call is recorded per target and kept out of the denominators", async () => {
  const row = { category: "implementations", repro: { callFailed: true, error: "boom" } };
  assert.deepEqual(hypotheses(row), []);
  assert.deepEqual([summarize([row]).callFailed, summarize([row]).reproduced], [1, 0]);
});
