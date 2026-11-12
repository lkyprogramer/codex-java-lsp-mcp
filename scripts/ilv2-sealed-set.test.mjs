import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sha256 } from "./ilv2-mac-contracts.mjs";
import { convertDataset, readJsonl, verifyDataset } from "./ilv2-mac-eval-dataset.mjs";
import { evalFixture, removeTree } from "./ilv2-mac-eval-fixture.mjs";
import { prepareMac10Live } from "./eval-mac10-live.mjs";
import { runDiagnosis } from "./ilv2-ranking-diagnosis.mjs";
import { cpSync } from "node:fs";
import { rm } from "node:fs/promises";
import { SEALED_RULES, corpusCandidates, exclusionReasons, freezeSealed, generateSealed, javaFacts, mapperFacts, quotaFor, selectSealed } from "./ilv2-sealed-set.mjs";

const execute = promisify(execFile);

const SHOP = {
  "src/main/java/shop/api/Discount.java": "package shop.api;\n\npublic interface Discount {\n    int apply(int amount);\n\n    String label();\n}\n",
  "src/main/java/shop/impl/FlatDiscount.java": "package shop.impl;\n\nimport shop.api.Discount;\n\npublic final class FlatDiscount implements Discount {\n    @Override\n    public int apply(int amount) {\n        return amount - 5;\n    }\n\n    @Override\n    public String label() {\n        return \"flat\";\n    }\n}\n",
  "src/main/java/shop/impl/TieredDiscount.java": "package shop.impl;\n\nimport shop.api.*;\n\npublic final class TieredDiscount implements Discount, Comparable<TieredDiscount> {\n    public int apply(int amount) {\n        return amount > 100 ? amount - 20 : amount;\n    }\n\n    public int compareTo(TieredDiscount other) {\n        return 0;\n    }\n}\n",
  "src/main/java/shop/OrderService.java": "package shop;\n\npublic class OrderService {\n    private String name;\n\n    public String getName() {\n        return name;\n    }\n\n    public int total(int amount) {\n        int value = amount;\n        return value;\n    }\n\n    public int apply(int amount) {\n        return amount;\n    }\n\n    public void load(int id) {\n    }\n\n    public void load(String key) {\n    }\n\n    @Override\n    public String toString() {\n        return name;\n    }\n\n    static final class Audit {\n        void record(String event) {\n            System.out.println(event);\n        }\n    }\n}\n",
  "src/main/java/shop/OrderMapper.java": "package shop;\n\npublic interface OrderMapper {\n    long findTotal(long id);\n\n    int countAll();\n\n    Order getById(long id);\n}\n",
  "src/main/resources/shop/OrderMapper.xml": "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<mapper namespace=\"shop.OrderMapper\">\n  <select id=\"findTotal\"\n          resultType=\"long\">\n    select total\n    from orders where id = #{id}\n  </select>\n  <select id=\"countAll\" resultType=\"int\">select count(*) from orders</select>\n  <select id=\"getById\">select * from orders where id = #{id}</select>\n</mapper>\n",
  "src/main/java/legacy/PriceRule.java": "package legacy;\n\npublic interface PriceRule {\n    int apply(int amount);\n}\n",
  "src/main/java/legacy/BasicRule.java": "package legacy;\n\npublic class BasicRule implements PriceRule {\n    public int apply(int amount) {\n        return amount;\n    }\n}\n",
  "src/test/java/shop/OrderServiceTest.java": "package shop;\n\nclass OrderServiceTest {\n    int total() {\n        return new OrderService().total(1);\n    }\n}\n"
};

const parsed = () => ({
  javaFiles: Object.entries(SHOP).filter(([file]) => file.endsWith(".java")).map(([file, text]) => ({ path: file, facts: javaFacts(text) })),
  xmlFiles: Object.entries(SHOP).filter(([file]) => file.endsWith(".xml")).map(([file, text]) => ({ path: file, facts: mapperFacts(text) }))
});
const noExposure = { terms: new Set(), evidence: new Set() };

test("javaFacts: package, imports, nested types, supertypes without type arguments, method head lines", () => {
  const facts = javaFacts(SHOP["src/main/java/shop/impl/TieredDiscount.java"]);
  assert.equal(facts.pkg, "shop.impl");
  assert.deepEqual(facts.imports, ["shop.api.*"]);
  assert.deepEqual(facts.types[0].supers, ["Discount", "Comparable"]);
  const service = javaFacts(SHOP["src/main/java/shop/OrderService.java"]);
  assert.deepEqual(service.types.map(type => type.fqn), ["shop.OrderService", "shop.OrderService.Audit"]);
  const toString = service.types[0].methods.find(method => method.name === "toString");
  assert.deepEqual([toString.startLine, toString.nameLine, toString.endLine], [25, 26, 28], "annotations belong to the head");
  assert.equal(service.types[0].methods.filter(method => method.name === "load").length, 2);
});

test("mapperFacts: namespace and statement lines, a multi-line opening tag included", () => {
  const facts = mapperFacts(SHOP["src/main/resources/shop/OrderMapper.xml"]);
  assert.equal(facts.namespace, "shop.OrderMapper");
  assert.deepEqual(facts.statements, [{ id: "findTotal", startLine: 3, endLine: 7 }, { id: "countAll", startLine: 8, endLine: 8 }, { id: "getById", startLine: 9, endLine: 9 }]);
  assert.equal(mapperFacts("<beans/>"), null);
});

test("corpusCandidates: declaration, implementations and xml rules, trivial and ambiguous-in-owner members excluded", () => {
  const candidates = corpusCandidates({ corpusId: "shop", ...parsed() });
  const keys = candidates.map(item => `${item.category}/${item.shape}:${item.anchors.join("#")}`).sort();
  for (const key of ["declaration/method:OrderService#total", "declaration/method:OrderService#apply", "declaration/method:Audit#record",
    "implementations/method:Discount#apply", "implementations/method:Discount#label", "xml/method:OrderMapper#findTotal", "xml/method:OrderMapper#countAll",
    "xml/method:OrderMapper#getById", "declaration/method:OrderMapper#getById"]) {
    assert.ok(keys.includes(key), key);
  }
  // A type target names one usable member of its own, chosen by the sample seed.
  const typeTarget = candidates.find(item => item.shape === "type" && item.anchors[0] === "OrderService");
  assert.ok(["total", "apply"].includes(typeTarget.anchors[1]));
  assert.deepEqual(typeTarget.targets.map(item => [item.role, item.startLine, item.endLine]), [["declaration", 3, 3]]);
  for (const name of ["getName", "toString", "load"]) assert.ok(!candidates.some(item => item.anchors[1] === name), `${name} is not a target`);
  // getById has no body: an interface method is never an accessor by length.
  assert.ok(!candidates.some(item => item.targets.some(target => target.path.includes("src/test/") && target.role === "declaration")), "no test-source declaration targets");
  const apply = candidates.find(item => item.category === "implementations" && item.anchors.join("#") === "Discount#apply");
  assert.deepEqual(apply.targets.map(item => [item.role, item.path, item.startLine, item.endLine]), [
    ["declaration", "src/main/java/shop/api/Discount.java", 4, 4],
    ["relation", "src/main/java/shop/impl/FlatDiscount.java", 6, 7],
    ["relation", "src/main/java/shop/impl/TieredDiscount.java", 6, 6]]);
  assert.equal(apply.sameNameCount, 6, "every apply declaration in the corpus, test sources included");
  const total = candidates.find(item => item.anchors.join("#") === "OrderService#total");
  assert.equal(total.sameNameCount, 2, "the test method of the same name counts");
  const xml = candidates.find(item => item.category === "xml" && item.anchors[1] === "findTotal");
  assert.deepEqual(xml.targets.map(item => [item.role, item.path, item.startLine, item.endLine]), [
    ["declaration", "src/main/java/shop/OrderMapper.java", 4, 4], ["relation", "src/main/resources/shop/OrderMapper.xml", 3, 7]]);
  assert.deepEqual(corpusCandidates({ corpusId: "shop", ...parsed() }).map(item => item.id), candidates.map(item => item.id), "deterministic");
});

test("exclusionReasons: exposed anchors, majority-exposed evidence files and prompt leaks", () => {
  const [candidate] = corpusCandidates({ corpusId: "shop", ...parsed() }).filter(item => item.category === "implementations" && item.anchors[0] === "PriceRule");
  assert.deepEqual(exclusionReasons(candidate, { terms: new Set(["PriceRule"]), evidence: new Set() }), ["EXPOSED_ANCHOR"]);
  assert.deepEqual(exclusionReasons(candidate, { terms: new Set(), evidence: new Set(["shop\0src/main/java/legacy/PriceRule.java"]) }), [], "half of the files is not a majority");
  assert.deepEqual(exclusionReasons(candidate, { terms: new Set(), evidence: new Set(["shop\0src/main/java/legacy/PriceRule.java", "shop\0src/main/java/legacy/BasicRule.java"]) }), ["EXPOSED_EVIDENCE"]);
  assert.deepEqual(exclusionReasons({ ...candidate, prompt: `${candidate.prompt} See \`BasicRule\`.` }, noExposure), ["LEAK"]);
});

test("quota and selection: seeded order per stratum, quota grows to the sealed minimum, rounds move to the next block, audit is a ceil quarter", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: `S-${String(i).padStart(2, "0")}`, corpusId: i % 2 ? "a" : "b", category: "declaration" }));
  const rules = { ...SEALED_RULES, quotaPerStratum: 4, minSealed: 10 };
  assert.deepEqual(quotaFor({ x: 15, y: 15 }, rules), { quota: 6, plannedSealed: 10 });
  assert.deepEqual(quotaFor({ x: 2, y: 2 }, rules), { quota: 4, plannedSealed: 4 }, "never beyond the largest stratum");
  const first = selectSealed(rows, { rules });
  assert.equal(first.quota, 6);
  assert.equal(first.selected.length, 12);
  assert.equal(first.audit.length, 4);
  assert.deepEqual(selectSealed([...rows].reverse(), { rules }).selected.map(row => row.id), first.selected.map(row => row.id), "input order does not matter");
  const redo = selectSealed(rows, { rules, rounds: { "a/declaration": 1 } });
  const stratumA = row => row.stratum === "a/declaration";
  assert.equal(redo.selected.filter(stratumA).filter(row => first.selected.some(old => old.id === row.id)).length, 0, "a redone stratum takes the next block");
  assert.deepEqual(redo.selected.filter(row => !stratumA(row)).map(row => row.id), first.selected.filter(row => !stratumA(row)).map(row => row.id));
});

/** Same contract as materializeCorpus (frozen tree without .git, overlays, hidden tests removed), portable copy. */
async function copyMaterialize({ record, corpus, oraclesRoot, target }) {
  cpSync(record.repoRoot, target, { recursive: true, filter: src => !path.relative(record.repoRoot, src).split(path.sep).includes(".git") });
  for (const overlay of corpus.overlays) await writeFile(path.join(target, overlay.path), await readFile(path.join(oraclesRoot, overlay.taskId, "pre-state.java"), "utf8"));
  for (const file of corpus.hidden ?? []) await rm(path.join(target, file.path));
  return target;
}

async function shopRepo(dir) {
  const repoRoot = path.join(dir, "shop");
  for (const [file, text] of Object.entries(SHOP)) {
    await mkdir(path.dirname(path.join(repoRoot, file)), { recursive: true });
    await writeFile(path.join(repoRoot, file), text);
  }
  const git = (...args) => execute("git", ["-C", repoRoot, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
  await git("init", "-q", "-b", "main");
  await git("add", "-A");
  await git("commit", "-q", "-m", "shop");
  const head = (await git("rev-parse", "HEAD")).stdout.trim();
  const manifestText = `${JSON.stringify({ schema: "ilv2-mac-input/v1", repoRoot, head, files: [] })}\n`;
  const manifest = path.join(dir, "shop-input.json");
  await writeFile(manifest, manifestText);
  const inputsFile = path.join(dir, "inputs.json");
  await writeFile(inputsFile, `${JSON.stringify([{ name: "shop", repoRoot, head, manifest, manifestSha256: sha256(manifestText), inputFiles: Object.keys(SHOP).length }])}\n`);
  return { repoRoot, head, inputsFile };
}

test("generate and freeze: clean inputs, exposure from an earlier dataset, audit gate, a MAC-10 dataset of locate tasks", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "sealed-set-"));
  t.after(() => removeTree(dir));
  const exposed = await evalFixture(path.join(dir, "v3"));
  await convertDataset({ curationFile: exposed.curationFile, inputsFile: exposed.inputsFile, candidateFiles: [exposed.candidatesFile], out: path.join(dir, "v3-dataset") });
  const excludeDataset = path.join(dir, "v3-dataset/dataset-manifest.json");
  const shop = await shopRepo(dir);
  const rules = { ...SEALED_RULES, quotaPerStratum: 10, minSealed: 4 };
  const summary = await generateSealed({ inputsFile: shop.inputsFile, excludeDataset, out: path.join(dir, "gen"), rules });
  assert.equal(summary.excluded.EXPOSED_ANCHOR > 0, true, "PriceRule is a v3 anchor");
  assert.equal(summary.belowMinimum, false);
  assert.ok(summary.eligible["shop/xml"] >= 2 && summary.eligible["shop/implementations"] >= 1);
  assert.doesNotMatch(JSON.stringify(summary), /OrderService|Discount|src\/main/, "summary carries counts only");
  const selection = JSON.parse(readFileSync(path.join(dir, "gen/selection.json"), "utf8"));
  assert.ok(!selection.selected.some(row => row.anchors.includes("PriceRule")));
  const sheetFile = path.join(dir, "gen/audit-sheet.json");
  const sheet = JSON.parse(readFileSync(sheetFile, "utf8"));
  assert.equal(sheet.entries.length, selection.audit.length);
  assert.ok(sheet.entries.every(entry => entry.targets.every(target => typeof target.source === "string" && target.source.length > 0)));

  const freeze = auditFile => freezeSealed({ selectionDir: path.join(dir, "gen"), auditFile, inputsFile: shop.inputsFile, out: path.join(dir, `ds-${path.basename(auditFile)}`) });
  await assert.rejects(freeze(sheetFile), /audit of .* is incomplete/);
  const fail = { ...sheet, entries: sheet.entries.map((entry, i) => ({ ...entry, verdict: i === 0 ? "FAIL" : "PASS", by: "auditor", at: "2026-11-12T00:00:00Z", notes: "checked against the source" })) };
  await writeFile(path.join(dir, "audit-fail.json"), JSON.stringify(fail));
  await assert.rejects(freeze(path.join(dir, "audit-fail.json")), new RegExp(`audit failed in ${sheet.entries[0].stratum.replace("/", "\\/")}: regenerate with --rounds`));
  const pass = { ...fail, entries: fail.entries.map(entry => ({ ...entry, verdict: "PASS" })) };
  await writeFile(path.join(dir, "audit-pass.json"), JSON.stringify(pass));
  // The rules travel with the selection; a lower minimum is not something freeze can be talked into.
  const manifest = await freeze(path.join(dir, "audit-pass.json"));
  const { root } = await verifyDataset(path.join(dir, "ds-audit-pass.json/dataset-manifest.json"));
  assert.equal(manifest.datasetId, "d15-sealed-v1");
  assert.ok(manifest.counts.bySplit.holdout >= 4);
  assert.deepEqual(Object.keys(manifest.counts.byKind), ["locate"]);
  const gold = [...await readJsonl(path.join(root, manifest.parts["gold-holdout"].file)), ...await readJsonl(path.join(root, manifest.parts["gold-dev"].file))];
  assert.ok(gold.every(row => row.requiredEvidence.some(item => item.role === "declaration") && !row.answer && !row.repairOracle));
  const audited = new Set(selection.audit);
  assert.ok(gold.filter(row => audited.has(row.taskId)).every(row => row.verification.by === "auditor"));
  assert.ok(gold.filter(row => !audited.has(row.taskId)).every(row => row.verification.by === "ilv2-sealed-set generator"));
  const tasks = await readJsonl(path.join(root, manifest.parts["tasks-holdout"].file));
  assert.ok(tasks.every(task => task.kind === "locate" && task.anchors.length === 2 && !/src\//.test(task.prompt)));

  // The frozen set feeds the ranking diagnosis unchanged; its declaration targets are matched by identity.
  const split = tasks.some(task => task.anchors.join("#") === "Discount#apply" && task.category === "implementations") ? "holdout" : "dev";
  const splitTasks = await readJsonl(path.join(root, manifest.parts[`tasks-${split}`].file));
  const discountApply = splitTasks.find(task => task.anchors.join("#") === "Discount#apply" && task.category === "implementations");
  const index = Object.entries(SHOP).filter(([file]) => file.endsWith(".java")).flatMap(([file, text]) => javaFacts(text).types.flatMap(type => [
    { declaration: { relativePath: file, name: type.name, fqn: type.fqn, kind: "type", selection: { line: type.nameLine, column: 1 } } },
    ...type.methods.map(method => ({ declaration: { relativePath: file, name: method.name, fqn: `${type.fqn}#${method.name}`, kind: "method", selection: { line: method.nameLine, column: 1 } } }))]))
    .sort((a, b) => a.declaration.relativePath.localeCompare(b.declaration.relativePath));
  const dist = path.join(dir, "dist");
  await mkdir(dist);
  await writeFile(path.join(dist, "build-stamp.json"), "{}");
  // Exact-route stand-in: every declaration of that simple name, in path order.
  const openSession = async () => ({ readyMs: 1, close: async () => {}, call: async (_name, args) => {
    const candidates = args.terms || args.searchMode ? [] : index.filter(item => item.declaration.name === args.query);
    return { exact: candidates.length > 1 ? "ambiguous" : candidates.length ? "match" : "miss", candidates };
  } });
  const report = await runDiagnosis({ datasetFile: path.join(root, "dataset-manifest.json"), tasksFile: path.join(root, manifest.parts[`tasks-${split}`].file),
    goldFile: path.join(root, manifest.parts[`gold-${split}`].file), inputsFile: shop.inputsFile, serverJs: path.join(dist, "server.js"), out: path.join(dir, "diag"),
    taskIds: [discountApply.taskId], openSession, materialize: copyMaterialize });
  assert.equal(report.declarationTargets, 1);
  // localeCompare path order of the six apply declarations: legacy/BasicRule, legacy/PriceRule, shop/api/Discount,
  // shop/impl/FlatDiscount, shop/impl/TieredDiscount, shop/OrderService.
  assert.deepEqual(report.declarationHitAt, { 1: 0, 3: 1, 8: 1, 20: 1 }, "Discount#apply is the 3rd apply; the Discount type candidate does not count");
  const row = JSON.parse(readFileSync(path.join(dir, "diag/rows.jsonl"), "utf8").trim());
  assert.deepEqual(row.targets.map(item => [item.role, item.rank, item.mechanism]), [["declaration", 3, "EXACT_AMBIGUOUS"], ["relation", 4, "EXACT_AMBIGUOUS"], ["relation", 5, "EXACT_AMBIGUOUS"]]);

  // A dirty input checkout is refused before anything is generated.
  await writeFile(path.join(shop.repoRoot, "stray.class"), "x");
  await assert.rejects(generateSealed({ inputsFile: shop.inputsFile, excludeDataset, out: path.join(dir, "gen2"), rules }), /untracked, ignored or modified/);
});

test("the converter accepts locate tasks only in their own shape", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "sealed-convert-"));
  t.after(() => removeTree(dir));
  const shop = await shopRepo(dir);
  const base = { id: "S-LOCATE", repo: "shop", kind: "locate", category: "declaration", source: { type: "static-head", commit: shop.head },
    prompt: "Locate the declaration of method `total` in type `OrderService`.", anchors: ["OrderService", "total"],
    evidence: [{ path: "src/main/java/shop/OrderService.java", startLine: 10, endLine: 10, role: "declaration", why: "method head of total" }],
    verification: { by: "t", at: "2026-11-12T00:00:00Z", method: "generated", notes: "fixture locate task for the converter" } };
  const convert = async (task, name) => {
    const curationFile = path.join(dir, `${name}.json`);
    await writeFile(curationFile, JSON.stringify({ schema: "ilv2-mac10-curation/v1", datasetId: "locate-fx", holdout: { ratio: 0.5, seed: "s" }, tasks: [task] }));
    return convertDataset({ curationFile, inputsFile: shop.inputsFile, candidateFiles: [], out: path.join(dir, `out-${name}`) });
  };
  const manifest = await convert(base, "ok");
  assert.equal(manifest.counts.byKind.locate, 1);
  const split = manifest.counts.bySplit.holdout ? "holdout" : "dev";
  await assert.rejects(prepareMac10Live({ datasetFile: path.join(dir, "out-ok/dataset-manifest.json"), tasksFile: path.join(dir, `out-ok/tasks-${split}.jsonl`),
    goldFile: path.join(dir, `out-ok/private/gold-${split}.jsonl`), inputsFile: shop.inputsFile, outputDir: path.join(dir, "live"), sourceBudget: null }), /locate task; the live adapter scores qa and repair only/);
  await assert.rejects(convert({ ...base, answer: { slots: { a: { type: "string" } }, value: { a: "x" } } }, "answer"), /neither answer nor repair/);
  await assert.rejects(convert({ ...base, evidence: [{ ...base.evidence[0], role: "relation" }] }, "norole"), /needs a declaration target/);
  await assert.rejects(convert({ ...base, evidence: [{ ...base.evidence[0], role: "other" }] }, "badrole"), /unknown role/);
  await assert.rejects(convert({ ...base, kind: "qa" }, "qa"), /declaration tasks are locate tasks/);
  await assert.rejects(convert({ ...base, source: { type: "static-head", commit: "0".repeat(40) } }, "head"), /must be the frozen head/);
  await assert.rejects(convert({ ...base, source: { ...base.source, parent: shop.head } }, "parent"), /carry no parent/);
});
