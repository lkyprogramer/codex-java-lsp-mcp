#!/usr/bin/env node
// D15 C: read-only MyBatis census, model-free and product-free. Answers whether a MyBatis discovery study is worth a
// new sample: how much mapper XML the frozen MAC-10 corpora contain, how much MyBatis-Plus replaces it, and how many
// dev gold ranges touch mapper XML or mapper interfaces. Holdout gold is never read. Counts only in summary.json.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { cliOptions, isMain, readJson, requireValue, runCli, sha256 } from "./ilv2-mac-contracts.mjs";
import { verifyDataset } from "./ilv2-mac-eval-dataset.mjs";
import { materializeCorpus } from "./ilv2-mac-retrieval-eval.mjs";

export const CENSUS_SCHEMA = "post-ilv2/mybatis-census/v1";
const PROLOG_OR_COMMENT = /<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/g;
const STATEMENT = /<\s*(select|insert|update|delete)\b[^>]*\bid\s*=/g;
const SKIP_DIRS = new Set([".git", "node_modules", "target", "build", ".gradle", ".idea"]);

/** Same root-tag rule as src/java-index/mybatis-xml-extractor.ts isMyBatisMapperFile. */
export function isMapperXml(text) {
  return /<\s*([A-Za-z][\w.-]*)/.exec(text.replace(PROLOG_OR_COMMENT, ""))?.[1] === "mapper";
}
export const statementCount = text => (text.replace(PROLOG_OR_COMMENT, "").match(STATEMENT) ?? []).length;
/** Java-side MyBatis signals: annotation mapper, MyBatis-Plus base mapper/service, inline SQL annotations. */
export function javaSignals(text) {
  return {
    mapperAnnotation: /@Mapper\b/.test(text),
    plusBaseMapper: /\bextends\s+BaseMapper\s*</.test(text),
    plusService: /\b(?:extends\s+ServiceImpl\s*<|IService\s*<)/.test(text),
    plusWrapper: /\b(?:Lambda)?(?:Query|Update)Wrapper\s*</.test(text),
    sqlAnnotation: /@(?:Select|Insert|Update|Delete)\s*\(/.test(text)
  };
}

async function walk(root, relative = "", out = []) {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) await walk(root, name, out); }
    else if (/\.(xml|java)$/.test(entry.name)) out.push(name);
  }
  return out;
}

/** Census of one materialized corpus. Returns counts plus the set of mapper XML paths and mapper Java paths. */
export async function censusCorpus(root) {
  const counts = { xmlFiles: 0, mapperXmlFiles: 0, mapperStatements: 0, javaFiles: 0, mapperAnnotation: 0, plusBaseMapper: 0, plusService: 0, plusWrapper: 0, sqlAnnotation: 0 };
  const mapperXml = new Set();
  const mapperJava = new Set();
  for (const file of await walk(root)) {
    if (/(?:^|\/)src\/test\//.test(file)) continue;
    const text = await readFile(path.join(root, file), "utf8").catch(() => "");
    if (file.endsWith(".xml")) {
      counts.xmlFiles += 1;
      if (isMapperXml(text)) { counts.mapperXmlFiles += 1; counts.mapperStatements += statementCount(text); mapperXml.add(file); }
      continue;
    }
    counts.javaFiles += 1;
    const signals = javaSignals(text);
    for (const [key, value] of Object.entries(signals)) if (value) counts[key] += 1;
    if (signals.mapperAnnotation || signals.plusBaseMapper || signals.sqlAnnotation) mapperJava.add(file);
  }
  return { counts, mapperXml, mapperJava };
}

/** Dev gold ranges classified against one corpus census. */
export function classifyGold(ranges, census) {
  const out = { ranges: 0, mapperXml: 0, mapperJava: 0, otherXml: 0, tasksTouchingMyBatis: 0 };
  for (const task of ranges) {
    let touched = false;
    for (const item of task.ranges) {
      out.ranges += 1;
      if (census.mapperXml.has(item.path)) { out.mapperXml += 1; touched = true; }
      else if (census.mapperJava.has(item.path)) { out.mapperJava += 1; touched = true; }
      else if (item.path.endsWith(".xml")) out.otherXml += 1;
    }
    if (touched) out.tasksTouchingMyBatis += 1;
  }
  return out;
}

export async function runCensus({ datasetFile, tasksFile, goldFile, inputsFile, out, materialize = materializeCorpus }) {
  const { root, manifest } = await verifyDataset(datasetFile);
  const tasksBytes = await readFile(tasksFile);
  requireValue(manifest.parts["tasks-dev"]?.sha256 === sha256(tasksBytes), "tasks file is not this dataset's dev split; the census never reads holdout");
  const goldBytes = await readFile(goldFile);
  requireValue(manifest.parts["gold-dev"]?.sha256 === sha256(goldBytes), "gold file is not this dataset's dev gold");
  const tasks = tasksBytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const gold = new Map(goldBytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).map(row => [row.taskId, row.requiredEvidence ?? []]));
  await mkdir(out);
  const corpusManifest = await readJson(path.join(root, manifest.parts.corpus.file));
  const inputs = new Map((await readJson(inputsFile)).map(record => [record.name, record]));
  const corpora = {};
  for (const corpus of corpusManifest.corpora) {
    const record = inputs.get(corpus.corpusId);
    requireValue(record && record.head === corpus.head && record.manifestSha256 === corpus.inputManifestSha256, `corpus ${corpus.corpusId} does not match its frozen input`);
    const corpusRoot = await materialize({ record, corpus, oraclesRoot: path.join(root, "private/oracles"), target: path.join(out, "corpora", corpus.corpusId) });
    const census = await censusCorpus(corpusRoot);
    const devTasks = tasks.filter(task => task.corpusId === corpus.corpusId);
    corpora[corpus.corpusId] = { ...census.counts, devTasks: devTasks.length,
      devGold: classifyGold(devTasks.map(task => ({ ranges: gold.get(task.taskId) ?? [] })), census) };
  }
  const summary = {
    schema: CENSUS_SCHEMA,
    identity: { datasetId: manifest.datasetId, datasetDigest: manifest.datasetDigest, split: "dev", tasksSha256: sha256(tasksBytes), goldSha256: sha256(goldBytes) },
    corpora,
    notClaimed: "Text counts over corpus main sources (src/test excluded). Mapper XML uses the index's root-tag rule; Java signals are regex heuristics. No product call, no holdout gold."
  };
  await writeFile(path.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

async function main(args) {
  const options = cliOptions(args, ["--dataset", "--tasks", "--gold", "--inputs", "--out"]);
  for (const name of ["dataset", "tasks", "gold", "inputs", "out"]) requireValue(options[name], `--${name} is required`);
  console.log(JSON.stringify(await runCensus({ datasetFile: path.resolve(options.dataset), tasksFile: path.resolve(options.tasks), goldFile: path.resolve(options.gold),
    inputsFile: path.resolve(options.inputs), out: path.resolve(options.out) }), null, 2));
}

if (isMain(import.meta.url)) runCli(() => main(process.argv.slice(2)));
