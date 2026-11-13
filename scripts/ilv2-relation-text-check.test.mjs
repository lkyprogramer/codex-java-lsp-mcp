import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { CLASSES, UNDETERMINED, anchorNames, bestLink, classifyLink, exactAnchors, hierarchyOf, linkForTarget, runRelationTextCheck, stripJava, summarize, superDepth, typeHeaders } from "./ilv2-relation-text-check.mjs";

test("headers survive generics, annotations, records and comments; literals do not create types", () => {
  const text = stripJava(`// class Fake implements PriceRule {
/* interface Ghost { */
String s = "class Str implements PriceRule {";
public final class Gold<T extends Comparable<T>> extends Base<Map<String, T>> implements PriceRule, java.io.Serializable, @Ann Other<T> {
  record Point(int x, int y) implements Shape {}
  enum Mode implements PriceRule { A }
}`);
  const headers = typeHeaders(text);
  assert.deepEqual(headers.map(header => [header.name, header.supers]), [
    ["Gold", ["Base", "PriceRule", "Serializable", "Other"]], ["Point", ["Shape"]], ["Mode", ["PriceRule"]]]);
  assert.equal(headers[0].line, 4);
});

test("supertype depth walks the corpus hierarchy and stops at the cap", () => {
  const graph = hierarchyOf(["interface PriceRule {}", "abstract class AbstractRule implements PriceRule {}", "class Vip extends AbstractRule {}",
    "class A extends B {}", "class B extends C {}", "class C extends D {}", "class D extends E {}", "class E implements PriceRule {}"]);
  assert.equal(superDepth(graph, ["AbstractRule"], "PriceRule"), 1);
  assert.equal(superDepth(graph, ["Vip"], "PriceRule"), 2);
  assert.equal(superDepth(graph, ["A"], "PriceRule"), null, "five hops exceed MAX_DEPTH 4");
  assert.equal(superDepth(graph, ["PriceRule"], "PriceRule"), null);
});

test("anchor names: a method fqn is owner#member", () => {
  assert.deepEqual(anchorNames({ kind: "method", name: "clamp", fqn: "demo.util.Calc#clamp" }), { type: "Calc", member: "clamp" });
  assert.deepEqual(anchorNames({ kind: "type", name: "PriceRule", fqn: "demo.PriceRule" }), { type: "PriceRule", member: null });
  assert.deepEqual(anchorNames({ kind: "method", name: "run", fqn: "demo.Outer$Inner#run" }), { type: "Inner", member: "run" });
});

const lines = text => stripJava(text).split("\n");
const typeAnchor = { kind: "type", name: "PriceRule", fqn: "demo.PriceRule", relativePath: "src/PriceRule.java" };
const methodAnchor = { kind: "method", name: "clamp", fqn: "demo.Calc#clamp", relativePath: "src/Calc.java" };

test("link classes per category", () => {
  const graph = hierarchyOf(["interface PriceRule {}", "abstract class AbstractRule implements PriceRule {}"]);
  const impl = (text, item = { path: "src/X.java", startLine: 1, endLine: 3 }, anchor = typeAnchor) => classifyLink({ category: "implementations", item, anchor, lines: lines(text), graph });
  assert.equal(impl("class X {}", { path: "src/PriceRule.java", startLine: 1, endLine: 1 }).linkClass, "SAME_FILE");
  assert.deepEqual(impl("class X implements PriceRule {}"), { linkClass: "DIRECT", depth: 1 });
  assert.deepEqual(impl("class X extends AbstractRule {}"), { linkClass: "INDIRECT", depth: 2 });
  assert.equal(impl("class X { PriceRule rule; }").linkClass, "MENTION_ONLY");
  assert.equal(impl("class X { /* PriceRule */ }").linkClass, "NO_TEXT_LINK", "comments do not count");
  const callers = (text, startLine, endLine) => classifyLink({ category: "callers", item: { path: "src/Y.java", startLine, endLine }, anchor: methodAnchor, lines: lines(text), graph });
  const source = "class Y {\n  int a() { return Calc.clamp (1, 2, 3); }\n  int b() { return a(); }\n}";
  assert.deepEqual(callers(source, 2, 2), { linkClass: "DIRECT", ownerMentioned: true });
  assert.deepEqual(callers(source, 3, 3), { linkClass: "INDIRECT", ownerMentioned: true }, "the call sits outside the gold range");
  assert.deepEqual(callers("class Y { void a() { repo.clamp(1); } }", 1, 1), { linkClass: "DIRECT", ownerMentioned: false }, "name-only: no type evidence");
  assert.equal(callers("class Y { int clamp; }", 1, 1).linkClass, "MENTION_ONLY");
  assert.equal(callers("class Y { String s = \"clamp(\"; }", 1, 1).linkClass, "NO_TEXT_LINK");
});

test("best link over anchors, exact anchors only, and rule gates", () => {
  assert.equal(bestLink([{ linkClass: "MENTION_ONLY" }, { linkClass: "INDIRECT" }, { linkClass: "NO_TEXT_LINK" }]).linkClass, "INDIRECT");
  assert.equal(bestLink([]), null);
  const observation = { terms: [
    { exact: "match", symbol: { candidates: [{ declaration: typeAnchor }] }, impacts: { C0: {} } },
    { exact: "ambiguous", symbol: { candidates: [{ declaration: methodAnchor }] }, impacts: { C0: {} } },
    { exact: "match", symbol: { candidates: [{ declaration: methodAnchor }] }, impacts: {} }] };
  assert.deepEqual(exactAnchors(observation), [typeAnchor]);
  const row = (linkClass, taskGroup, extra = {}) => ({ linkClass, taskGroup, category: "implementations", cause: "WEAK_RELATION", anchors: 1, hasMethodAnchor: false, ...extra });
  const summary = summarize([...["g1", "g1", "g2", "g2", "g3"].map(group => row("INDIRECT", group)), row("DIRECT", "g1"), row("NO_TEXT_LINK", "g4", { cause: "RELATION_MISSING" }),
    row("TYPE_ANCHOR_ONLY", "g5", { category: "callers" }), row("NO_ANCHOR", "g6", { anchors: 0 }), row("SAME_FILE", "g7"),
    row("DIRECT", "g8", { category: "callers", ownerMentioned: false, hasMethodAnchor: true }), row("DIRECT", "g9", { category: "callers", ownerMentioned: true, hasMethodAnchor: true })]);
  assert.deepEqual(Object.keys(summary.byClass), [...CLASSES, ...UNDETERMINED]);
  assert.deepEqual([summary.rules.targets, summary.rules.determinable, summary.rules.sameFile], [12, 10, 1]);
  assert.deepEqual([summary.rules.R_q05.triggered, summary.rules.R_q05.taskGroups], [false, 3], "5 of 10 determinable is not a majority");
  assert.deepEqual([summary.rules.R_defect.typedDirect, summary.rules.R_defect.allDirect, summary.rules.R_defect.triggered], [2, 3, false]);
  assert.equal(summary.rules.R_gold.value, 1, "SAME_FILE and undetermined rows stay out of R_gold");
  assert.deepEqual(summary.anchorKinds.callers, { methodAnchor: 2, typeAnchorOnly: 1, noAnchor: 0 });
  assert.equal(summary.byCause.RELATION_MISSING.NO_TEXT_LINK, 1);
  const majority = summarize([...["g1", "g2", "g2"].map(group => row("INDIRECT", group)), row("NO_TEXT_LINK", "g3")]).rules.R_q05;
  assert.equal(majority.triggered, true);
  assert.equal(summarize(["g1", "g1", "g1"].map(group => row("INDIRECT", group))).rules.R_q05.triggered, false, "one task group is not enough");
});

test("the run binds F artifacts and the dev split, and keeps names out of the summary", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "d17-"));
  try {
    const hash = text => createHash("sha256").update(text).digest("hex");
    const target = { path: "src/main/java/demo/VipRule.java", startLine: 1, endLine: 1 };
    const tasks = `${JSON.stringify({ taskId: "t1", corpusId: "c1", category: "implementations", anchors: ["PriceRule"] })}\n`;
    const gold = `${JSON.stringify({ taskId: "t1", requiredEvidence: [target] })}\n`;
    const responses = `${JSON.stringify({ taskId: "t1", terms: [{ exact: "match", symbol: { candidates: [{ declaration: { ...typeAnchor, relativePath: "src/main/java/demo/PriceRule.java" } }] },
      impacts: { C0: { diagnostic: { files: [{ id: "f1", path: target.path, role: "reference", reasons: ["typeGraph"] }], readPlan: [], evidenceGaps: [] } }, C3: { diagnostic: { files: [], readPlan: [], evidenceGaps: [] } } } }] })}\n`;
    const targets = [{ kind: "java", credited: false, label: "UNSELECTED" }];
    const rows = `${JSON.stringify({ taskId: "t1", category: "implementations", configs: { C0: { targets }, C3: { targets } } })}\n`;
    const files = { "tasks.jsonl": tasks, "gold.jsonl": gold, "responses.jsonl": responses, "rows.jsonl": rows, "inputs.json": JSON.stringify([{ name: "c1", head: "h", manifestSha256: "m", repoRoot: "unused" }]),
      "corpus.json": JSON.stringify({ corpora: [{ corpusId: "c1", head: "h", inputManifestSha256: "m", overlays: [], evidenceFiles: [] }] }) };
    for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text);
    const manifest = { datasetId: "fixture", datasetDigest: "d", parts: { "tasks-dev": { sha256: hash(tasks) }, "gold-dev": { sha256: hash(gold) }, corpus: { file: "corpus.json" } } };
    const materialize = async ({ target: root }) => {
      await mkdir(path.join(root, "src/main/java/demo"), { recursive: true });
      await writeFile(path.join(root, "src/main/java/demo/PriceRule.java"), "interface PriceRule {}");
      await writeFile(path.join(root, "src/main/java/demo/AbstractRule.java"), "abstract class AbstractRule implements PriceRule {}");
      await writeFile(path.join(root, target.path), "class VipRule extends AbstractRule {}");
      return root;
    };
    const args = { datasetFile: path.join(dir, "manifest.json"), tasksFile: path.join(dir, "tasks.jsonl"), goldFile: path.join(dir, "gold.jsonl"), inputsFile: path.join(dir, "inputs.json"),
      responsesFile: path.join(dir, "responses.jsonl"), rowsFile: path.join(dir, "rows.jsonl"), out: path.join(dir, "out"), verify: async () => ({ root: dir, manifest }), materialize };
    await assert.rejects(runRelationTextCheck({ ...args, expect: { responses: hash(responses), rows: "0".repeat(64) } }), /not the recorded D15-F artifact/);
    const summary = await runRelationTextCheck({ ...args, out: path.join(dir, "out2"), expect: { responses: hash(responses), rows: hash(rows) } });
    assert.deepEqual([summary.byClass.INDIRECT, summary.rules.targets, summary.identity.taskGroupField], [1, 1, "taskId"]);
    assert.match(await readFile(path.join(dir, "out2/link-rows.jsonl"), "utf8"), /VipRule/);
    assert.doesNotMatch(JSON.stringify(summary), /VipRule|PriceRule|demo/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("target-level link: no anchor, same file, type-only callers, then the best usable anchor", () => {
  const graph = hierarchyOf(["interface PriceRule {}"]);
  const item = { path: "src/Y.java", startLine: 1, endLine: 1 };
  const text = lines("class Y implements PriceRule { void a() { Calc.clamp(1); } }");
  assert.deepEqual(linkForTarget({ category: "callers", item, anchors: [], lines: text, graph }), { anchors: 0, hasMethodAnchor: false, linkClass: "NO_ANCHOR" });
  assert.equal(linkForTarget({ category: "callers", item, anchors: [typeAnchor], lines: text, graph }).linkClass, "TYPE_ANCHOR_ONLY");
  assert.equal(linkForTarget({ category: "callers", item, anchors: [typeAnchor, methodAnchor], lines: text, graph }).linkClass, "DIRECT");
  assert.equal(linkForTarget({ category: "implementations", item, anchors: [{ ...typeAnchor, relativePath: "src/Y.java" }], lines: text, graph }).linkClass, "SAME_FILE");
  assert.equal(linkForTarget({ category: "implementations", item, anchors: [methodAnchor, typeAnchor], lines: text, graph }).linkClass, "DIRECT");
});
