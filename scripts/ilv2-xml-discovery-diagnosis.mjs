#!/usr/bin/env node
// D15 XML-3, model-free. Locates where the product loses MyBatis XML evidence for every required range that lives
// in an .xml file of a frozen MAC-10 dev split. The product indexes one search document per mapper statement, bound
// to the same-named method of the Java type whose FQN equals the mapper namespace, with the text
// `mybatis <kind> <namespace>.<statementId>` only (src/discovery/search-document.ts pushMyBatisDocuments). Each target
// is walked down a fixed ladder; the first failing stage is its label:
//   1. NOT_STATEMENT       the gold range is not inside a <select|insert|update|delete id=...> element
//   2. NO_NAMESPACE_TYPE   no corpus Java file declares the mapper namespace at its conventional path
//   3. NO_SAME_NAMED_METHOD that type has no method named like the statement id
//   4. DOC_NOT_RETRIEVED   searchMode=text for the statement id returns no candidate whose evidence is this statement (limit 20)
//   5. DOC_RANK_GT8        it is returned, but below rank 8
//   6. TERMS_MISS_DOC      the task's own planned terms share no identifier with the indexed text (they name SQL content)
//   7. REACHABLE           a planned term could have retrieved it
// Separately, java_impact (the driver's balanced/compact call) at the mapper method shows whether the impact path
// selects the statement. Private rows stay under --out; summary.json carries counts only.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { cliOptions, isMain, readJson, requireValue, runCli, sha256 } from "./ilv2-mac-contracts.mjs";
import { verifyDataset } from "./ilv2-mac-eval-dataset.mjs";
import { materializeCorpus, planQueries } from "./ilv2-mac-retrieval-eval.mjs";
import { openProductSession } from "./ilv2-ranking-diagnosis.mjs";

export const XML_DIAGNOSIS_SCHEMA = "post-ilv2/xml-discovery-diagnosis/v1";
export const LADDER = Object.freeze(["NOT_STATEMENT", "NO_NAMESPACE_TYPE", "NO_SAME_NAMED_METHOD", "DOC_NOT_RETRIEVED", "DOC_RANK_GT8", "TERMS_MISS_DOC", "REACHABLE"]);
export const PROBE_LIMIT = 20;
const STATEMENT_TAGS = new Set(["select", "insert", "update", "delete"]);
const OPEN_TAG = /<\s*(select|insert|update|delete|sql|resultMap)\b[^>]*?\bid\s*=\s*["']([^"']+)["']/;

/** The element that holds a gold range: the nearest opening tag at or above its first line (within 80 lines). */
export function enclosingElement(lines, startLine) {
  for (let line = startLine; line >= Math.max(1, startLine - 80); line -= 1) {
    const match = OPEN_TAG.exec(lines[line - 1] ?? "");
    if (match) return { tag: match[1], id: match[2], line };
  }
  return null;
}
export function mapperNamespace(text) {
  return /<\s*mapper\b[^>]*\bnamespace\s*=\s*["']([^"']+)["']/.exec(text)?.[1] ?? null;
}

/** Identifier tokens the way the index splits them: whole words, camelCase and snake_case parts, lower-cased. */
export function identifierTokens(text) {
  const out = new Set();
  for (const word of String(text).match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) {
    out.add(word.toLowerCase());
    for (const part of word.split(/_+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) if (part) out.add(part.toLowerCase());
  }
  return out;
}
const GENERIC = new Set(["mybatis", "select", "insert", "update", "delete", "com", "cn", "org", "net", "mapper", "dao", "java"]);
/** True when a planned term shares a non-generic identifier token with the statement's indexed text. */
export function termsHitDocument(terms, docText) {
  const doc = new Set([...identifierTokens(docText)].filter(token => !GENERIC.has(token) && token.length >= 3));
  return terms.some(term => [...identifierTokens(term)].some(token => doc.has(token)));
}

const coversRange = (span, target) => span.startLine <= target.startLine && span.endLine >= target.endLine;
const overlapsRange = (span, target) => !(span.endLine < target.startLine || span.startLine > target.endLine);

/**
 * Ladder for one XML target. `call(name, args)` returns the parsed tool value; `readText(relativePath)` the corpus
 * text or null; `findJava(namespace)` the corpus-relative Java file declaring that FQN at its package path, or null.
 */
export async function diagnoseXmlTarget({ target, terms, readText, findJava, call }) {
  const row = { label: null, element: null, namespaceType: false, sameNamedMethod: false, probe: null, impact: null, termsHitDoc: null };
  const text = await readText(target.path);
  const lines = (text ?? "").split("\n");
  const element = text === null ? null : enclosingElement(lines, target.startLine);
  row.element = element?.tag ?? null;
  if (!element || !STATEMENT_TAGS.has(element.tag)) return { ...row, label: "NOT_STATEMENT" };
  const namespace = mapperNamespace(text);
  const javaPath = namespace ? findJava(namespace) : null;
  row.namespaceType = Boolean(javaPath);
  if (!javaPath) return { ...row, label: "NO_NAMESPACE_TYPE" };
  // Recorded for every bound statement, so a vocabulary mismatch is visible even when retrieval fails first.
  row.termsHitDoc = termsHitDocument(terms, `mybatis ${element.tag} ${namespace}.${element.id}`);
  const javaText = await readText(javaPath);
  const escaped = element.id.replace(/[$]/g, "\\$");
  row.sameNamedMethod = new RegExp(`(?<![\\w$])${escaped}\\s*\\(`).test(javaText ?? "");
  if (!row.sameNamedMethod) return { ...row, label: "NO_SAME_NAMED_METHOD" };
  // Impact at the mapper method: the exact selector the driver would need, then its balanced/compact read plan.
  const exact = await call("java_symbol", { operation: "query", query: `${namespace}#${element.id}`, limit: PROBE_LIMIT, preview: "none" });
  const method = (exact.candidates ?? [])[0];
  if (method) {
    const { relativePath, selection } = method.declaration;
    const compact = await call("java_impact", { file: relativePath, line: selection.line, column: selection.column, mode: "balanced", semanticPolicy: "fast", verbosity: "compact", deadlineMs: 15000 });
    const spans = (compact.contexts ?? []).filter(context => context.path === target.path).flatMap(context => (context.spans ?? []).map(span => ({ startLine: span.s, endLine: span.e })));
    row.impact = spans.some(span => coversRange(span, target)) ? "COVERED" : spans.length ? "SELECTED_RANGE_MISS"
      : (compact.contexts ?? []).some(context => context.path === target.path) ? "LISTED_NO_SPAN" : "ABSENT";
  } else row.impact = "NO_METHOD_CANDIDATE";
  const probe = await call("java_symbol", { operation: "query", query: element.id, searchMode: "text", limit: PROBE_LIMIT, preview: "none" });
  const rank = (probe.candidates ?? []).findIndex(candidate => candidate.evidenceRange?.relativePath === target.path && overlapsRange(candidate.evidenceRange, target));
  row.probe = rank < 0 ? null : rank + 1;
  if (row.probe === null) return { ...row, label: "DOC_NOT_RETRIEVED" };
  if (row.probe > 8) return { ...row, label: "DOC_RANK_GT8" };
  return { ...row, label: row.termsHitDoc ? "REACHABLE" : "TERMS_MISS_DOC" };
}

/** Lookup of Java files by FQN path suffix (`a/b/C.java` for `a.b.C`) over one corpus listing. */
export function javaFinder(javaFiles) {
  return namespace => {
    const suffix = `${namespace.replace(/\./g, "/")}.java`;
    return javaFiles.find(file => file === suffix || file.endsWith(`/${suffix}`)) ?? null;
  };
}
async function listJavaFiles(root, relative = "") {
  const out = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { if (entry.name !== ".git" && entry.name !== "node_modules") out.push(...await listJavaFiles(root, name)); }
    else if (entry.name.endsWith(".java")) out.push(name);
  }
  return out;
}

export function summarizeXml(rows) {
  const count = (values, keys) => Object.fromEntries(keys.map(key => [key, values.filter(value => value === key).length]));
  return {
    xmlTargets: rows.length,
    byLabel: count(rows.map(row => row.label), LADDER),
    byElement: rows.reduce((acc, row) => ({ ...acc, [row.element ?? "none"]: (acc[row.element ?? "none"] ?? 0) + 1 }), {}),
    impactAtMapperMethod: rows.filter(row => row.impact).reduce((acc, row) => ({ ...acc, [row.impact]: (acc[row.impact] ?? 0) + 1 }), {}),
    termsHitDocAmongBound: { yes: rows.filter(row => row.termsHitDoc === true).length, no: rows.filter(row => row.termsHitDoc === false).length },
    probeRanks: { "1-3": rows.filter(row => row.probe !== null && row.probe <= 3).length, "4-8": rows.filter(row => row.probe > 3 && row.probe <= 8).length, "9-20": rows.filter(row => row.probe > 8).length }
  };
}

export async function runXmlDiagnosis({ datasetFile, tasksFile, goldFile, inputsFile, serverJs, out, readyTimeoutMs = 900000, openSession = openProductSession, materialize = materializeCorpus }) {
  const { root, manifest } = await verifyDataset(datasetFile);
  const tasksBytes = await readFile(tasksFile);
  requireValue(manifest.parts["tasks-dev"]?.sha256 === sha256(tasksBytes), "tasks file is not this dataset's dev split; XML-3 never runs on holdout");
  const goldBytes = await readFile(goldFile);
  requireValue(manifest.parts["gold-dev"]?.sha256 === sha256(goldBytes), "gold file is not this dataset's dev gold");
  const tasks = tasksBytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const gold = new Map(goldBytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).map(row => [row.taskId, row.requiredEvidence ?? []]));
  await mkdir(out);
  const corpusManifest = await readJson(path.join(root, manifest.parts.corpus.file));
  const inputs = new Map((await readJson(inputsFile)).map(record => [record.name, record]));
  const rows = [];
  const sessions = {};
  for (const corpusId of [...new Set(tasks.map(task => task.corpusId))]) {
    const work = tasks.filter(task => task.corpusId === corpusId && (gold.get(task.taskId) ?? []).some(item => item.path.endsWith(".xml")));
    if (work.length === 0) continue;
    const record = inputs.get(corpusId);
    const corpus = corpusManifest.corpora.find(row => row.corpusId === corpusId);
    requireValue(record && corpus && record.head === corpus.head && record.manifestSha256 === corpus.inputManifestSha256, `corpus ${corpusId} does not match its frozen input`);
    const corpusRoot = await materialize({ record, corpus, oraclesRoot: path.join(root, "private/oracles"), target: path.join(out, "corpora", corpusId) });
    const readText = async relativePath => readFile(path.join(corpusRoot, relativePath), "utf8").catch(() => null);
    const findJava = javaFinder((await listJavaFiles(corpusRoot)).filter(file => !/(?:^|\/)src\/test\//.test(file)));
    const workDir = path.join(out, "sessions", corpusId);
    await mkdir(workDir, { recursive: true });
    const session = await openSession({ serverJs, corpusRoot, workDir, readyTimeoutMs });
    sessions[corpusId] = { readyMs: Math.round(session.readyMs) };
    try {
      for (const task of work) {
        const terms = planQueries(task).terms;
        for (const target of gold.get(task.taskId).filter(item => item.path.endsWith(".xml"))) {
          rows.push({ taskId: task.taskId, path: target.path, ...(await diagnoseXmlTarget({ target, terms, readText, findJava, call: session.call })) });
        }
      }
    } finally { await session.close(); }
  }
  await writeFile(path.join(out, "rows.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const summary = {
    schema: XML_DIAGNOSIS_SCHEMA,
    identity: { datasetId: manifest.datasetId, datasetDigest: manifest.datasetDigest, split: "dev", tasksSha256: sha256(tasksBytes), goldSha256: sha256(goldBytes),
      serverBuildStampSha256: sha256(await readFile(path.join(path.dirname(serverJs), "build-stamp.json"))), probeLimit: PROBE_LIMIT },
    sessions,
    ...summarizeXml(rows),
    notClaimed: "Locates the first failing stage per XML target from corpus text and product calls. Element, namespace and method checks are text heuristics mirroring the index rules; no reads, recall or agent outcome are measured."
  };
  await writeFile(path.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

async function main(args) {
  const options = cliOptions(args, ["--dataset", "--tasks", "--gold", "--inputs", "--server-js", "--out"]);
  for (const name of ["dataset", "tasks", "gold", "inputs", "server-js", "out"]) requireValue(options[name], `--${name} is required`);
  console.log(JSON.stringify(await runXmlDiagnosis({ datasetFile: path.resolve(options.dataset), tasksFile: path.resolve(options.tasks), goldFile: path.resolve(options.gold),
    inputsFile: path.resolve(options.inputs), serverJs: path.resolve(options["server-js"]), out: path.resolve(options.out) }), null, 2));
}

if (isMain(import.meta.url)) runCli(() => main(process.argv.slice(2)));
