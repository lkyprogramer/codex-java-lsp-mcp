import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { stripJava } from "./ilv2-relation-text-check.mjs";
import { creditedCallers, h0Verdict, hasPrimary, resolveSuper, runFollowupCheck, writtenSupers } from "./ilv2-relation-followup-check.mjs";

const FQN = "com.acme.port.PriceRule";

test("written supertypes keep qualified names and drop type parameters, arguments and permits", () => {
  assert.deepEqual(writtenSupers(stripJava("public class A<T extends X> extends Base<Map<String, T>> implements com.acme.port.PriceRule, Other<T> {}")),
    ["Base", "com.acme.port.PriceRule", "Other"]);
  assert.deepEqual(writtenSupers(stripJava("sealed interface S extends @Ann P permits A, B {}\nrecord R(int a) implements S {}")), ["P", "S"]);
});

test("resolution against the anchor FQN: explicit import, same package, wildcard, qualified, other same-name type", () => {
  const src = text => stripJava(text);
  assert.equal(resolveSuper(src("package com.acme.app;\nimport com.acme.port.PriceRule;\nclass A implements PriceRule {}"), "PriceRule", FQN), "anchor");
  assert.equal(resolveSuper(src("package com.acme.port;\nclass A implements PriceRule {}"), "PriceRule", FQN), "anchor");
  assert.equal(resolveSuper(src("package com.acme.app;\nimport com.acme.port.*;\nclass A implements PriceRule {}"), "PriceRule", FQN), "anchor");
  assert.equal(resolveSuper(src("package com.acme.app;\nclass A implements com.acme.port.PriceRule {}"), "com.acme.port.PriceRule", FQN), "anchor");
  assert.equal(resolveSuper(src("package com.acme.app;\nimport com.other.PriceRule;\nclass A implements PriceRule {}"), "PriceRule", FQN), "other-same-name");
  assert.equal(resolveSuper(src("package com.acme.app;\nclass A implements com.other.PriceRule {}"), "com.other.PriceRule", FQN), "other-same-name");
  assert.equal(resolveSuper(src("package com.acme.app;\nclass A implements PriceRule {}"), "PriceRule", FQN), "unresolved");
});

test("@Primary belongs to the declaration it annotates", () => {
  assert.equal(hasPrimary(stripJava("import x.Y;\n@Primary\n@Service\npublic class A implements P {}"), "A"), true);
  assert.equal(hasPrimary(stripJava("@org.springframework.context.annotation.Primary public class A {}"), "A"), true);
  assert.equal(hasPrimary(stripJava("@Primary class B {}\n@Service class A {}"), "A"), false);
  assert.equal(hasPrimary(stripJava("// @Primary\nclass A {}"), "A"), false);
  assert.equal(hasPrimary(stripJava("@Primary\n@Import({Cfg.class})\n@Service public class A {}"), "A"), true, "annotation arguments with braces do not end the window");
});

test("H0 verdicts", () => {
  const sub = (isTarget, primary, inPool, resolvesToAnchor = true) => ({ isTarget, primary, inPool, resolvesToAnchor });
  assert.equal(h0Verdict({ resolution: "other-same-name", subtypes: [] }), "SAME_NAME_OTHER_TYPE");
  assert.equal(h0Verdict({ resolution: "unresolved", subtypes: [] }), "UNDETERMINED");
  assert.equal(h0Verdict({ resolution: "anchor", subtypes: [sub(true, false, false), sub(false, true, true)] }), "PRIMARY_FILTER");
  assert.equal(h0Verdict({ resolution: "anchor", subtypes: [sub(true, false, false), sub(false, false, true)] }), "EDGE_MISSING");
  assert.equal(h0Verdict({ resolution: "anchor", subtypes: [sub(true, false, false), sub(false, true, false)] }), "EDGE_MISSING", "a Primary sibling that was not kept does not explain it");
  assert.equal(h0Verdict({ resolution: "anchor", subtypes: [sub(true, false, false), sub(false, true, true, false)] }), "EDGE_MISSING", "a Primary sibling of another same-name type does not explain it");
});

test("credited callers report labels and allow-listed reasons of the selected file", () => {
  const gold = new Map([["t1", { requiredEvidence: [{ path: "A.java" }, { path: "B.java" }, { path: "c.xml" }] }]]);
  const rows = [{ taskId: "t1", category: "callers", configs: { C0: { targets: [
    { kind: "java", credited: true, label: "IMPACT_SPAN" }, { kind: "java", credited: true, label: "SYMBOL_WINDOW" }, { kind: "other", credited: true, label: "IMPACT_SPAN" }] } } }];
  const observations = [{ taskId: "t1", terms: [{ impacts: { C0: { diagnostic: { files: [{ id: "f1", path: "A.java", reasons: ["typeReference", "rg:Secret"] }], readPlan: [{ fileId: "f1" }] } } } }] }];
  assert.deepEqual(creditedCallers({ rows, observations, gold }), { targets: 2, byLabel: { IMPACT_SPAN: 1, SYMBOL_WINDOW: 1 }, withProtectedReason: 0, impactSpanNotInPlan: 0, reasonKinds: { typeReference: 1 } });
  const elsewhere = [{ taskId: "t1", terms: [{ impacts: { C0: { diagnostic: { files: [], readPlan: [] } } } }] }];
  assert.equal(creditedCallers({ rows, observations: elsewhere, gold }).impactSpanNotInPlan, 1, "a credited span not found in any C0 plan is counted, not read as reason-less");
});

test("the run classifies a direct target end to end and keeps names out of the summary", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "d19-"));
  try {
    const hash = text => createHash("sha256").update(text).digest("hex");
    const anchor = { kind: "type", name: "PriceRule", relativePath: "port/src/main/java/com/acme/port/PriceRule.java", selection: { line: 1, column: 1 } };
    const target = { path: "app/src/main/java/com/acme/app/VipRule.java", startLine: 1, endLine: 3 };
    const sources = {
      [anchor.relativePath]: "package com.acme.port;\npublic interface PriceRule {}",
      "port/src/main/java/com/acme/port/DefaultRule.java": "package com.acme.port;\n@Primary\npublic class DefaultRule implements PriceRule {}",
      [target.path]: "package com.acme.app;\nimport com.acme.port.PriceRule;\npublic class VipRule implements PriceRule {}"
    };
    const tasks = `${JSON.stringify({ taskId: "t1", corpusId: "c1", category: "implementations" })}\n`;
    const gold = `${JSON.stringify({ taskId: "t1", requiredEvidence: [target] })}\n`;
    const diagnostic = { files: [{ id: "f1", path: "port/src/main/java/com/acme/port/DefaultRule.java", reasons: ["typeGraph:implementation-lookup"] }], readPlan: [{ fileId: "f1" }], evidenceGaps: [] };
    const responses = `${JSON.stringify({ taskId: "t1", terms: [{ exact: "match", symbol: { candidates: [{ declaration: anchor }] }, impacts: { C0: { diagnostic }, C3: { diagnostic } } }] })}\n`;
    const targets = [{ kind: "java", credited: false, label: "POOL_ABSENT" }];
    const rows = `${JSON.stringify({ taskId: "t1", category: "implementations", configs: { C0: { targets }, C3: { targets } } })}\n`;
    for (const [name, text] of Object.entries({ "tasks.jsonl": tasks, "gold.jsonl": gold, "responses.jsonl": responses, "rows.jsonl": rows,
      "inputs.json": JSON.stringify([{ name: "c1", head: "h", manifestSha256: "m", repoRoot: "unused" }]),
      "corpus.json": JSON.stringify({ corpora: [{ corpusId: "c1", head: "h", inputManifestSha256: "m", overlays: [], evidenceFiles: [] }] }) })) await writeFile(path.join(dir, name), text);
    const manifest = { datasetId: "fixture", datasetDigest: "d", parts: { "tasks-dev": { sha256: hash(tasks) }, "gold-dev": { sha256: hash(gold) }, corpus: { file: "corpus.json" } } };
    const materialize = async ({ target: root }) => {
      for (const [file, text] of Object.entries(sources)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
      return root;
    };
    const args = { datasetFile: "unused", tasksFile: path.join(dir, "tasks.jsonl"), goldFile: path.join(dir, "gold.jsonl"), inputsFile: path.join(dir, "inputs.json"),
      responsesFile: path.join(dir, "responses.jsonl"), rowsFile: path.join(dir, "rows.jsonl"), verify: async () => ({ root: dir, manifest }), materialize };
    await assert.rejects(runFollowupCheck({ ...args, out: path.join(dir, "o1"), expect: { responses: "0".repeat(64), rows: hash(rows) } }), /not the recorded D15-F artifact/);
    const summary = await runFollowupCheck({ ...args, out: path.join(dir, "out"), expect: { responses: hash(responses), rows: hash(rows) } });
    assert.deepEqual(summary.h0.byVerdict, { SAME_NAME_OTHER_TYPE: 0, PRIMARY_FILTER: 1, EDGE_MISSING: 0, UNDETERMINED: 0 });
    assert.deepEqual(summary.h0.rows[0].subtypes, [
      { isTarget: true, primary: false, inPool: false, implLookup: false, testSource: false, sameModuleAsAnchor: false, resolvesToAnchor: true },
      { isTarget: false, primary: true, inPool: true, implLookup: true, testSource: false, sameModuleAsAnchor: true, resolvesToAnchor: true }]);
    assert.equal(summary.h0.rows[0].sameNameDeclarations, 1);
    assert.match(await readFile(path.join(dir, "out/h0-rows.jsonl"), "utf8"), /VipRule/);
    assert.doesNotMatch(JSON.stringify(summary), /VipRule|PriceRule|acme/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
