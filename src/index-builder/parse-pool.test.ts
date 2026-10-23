import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJavaParserBackend } from "../java-index/java-parser-backend.js";
import { parseJavaSourceFile } from "../java-index/java-index-file-parse.js";
import { DEFAULT_PARSE_TREE_CACHE_OPTIONS, ParseTreeCache } from "../java-index/builder/parse-cache.js";
import { captureSource } from "../java-index/source-capture.js";
import { close, openIndexDb } from "../java-index/sql/driver.js";
import { diffLogical, exportLogical, logicalDigest } from "../java-index/sql/logical-export.js";
import { ensureSchema } from "../java-index/sql/schema.js";
import { runSqlColdBuild } from "./cold-build.js";
import { applyBuilderJob } from "./incremental.js";
import { parseOffThread } from "./parse-pool.js";

const source = (index: number, edit: string) => `package demo;
import java.util.List;
public class C${index} extends ${index === 0 ? "Object" : `C${index - 1}`} {
  private List<C${(index + 7) % 30}> peers;
  public C${index} next() { return new C${(index + 1) % 30}()${edit}; }
  public void touch(C${(index + 3) % 30} other) { other.next(); peers.size(); }
}
`;

async function fixture() {
  const repo = await mkdtemp(path.join(tmpdir(), "parse-pool-"));
  const dir = path.join(repo, "src/main/java/demo");
  await mkdir(dir, { recursive: true });
  const file = (index: number) => path.join(dir, `C${index}.java`);
  for (let index = 0; index < 30; index++) await writeFile(file(index), source(index, ""));
  return { repo, file };
}

test("off-thread parse returns each input's serial bundle, in input order, and a missing input's ENOENT", async () => {
  const { repo, file } = await fixture();
  try {
    const backend = await createJavaParserBackend();
    const cache = new ParseTreeCache({ ...DEFAULT_PARSE_TREE_CACHE_OPTIONS, maxEntries: 8 });
    const inputs = [];
    for (let index = 0; index < 30; index++) {
      inputs.push({ repoRoot: repo, resolvedRepoRoot: repo, inputPath: file(index), generation: 3, ...(index % 2 ? { capture: await captureSource(repo, file(index)) } : {}) });
    }
    const serial = [];
    for (const input of inputs) serial.push(await parseJavaSourceFile({ ...input, backend, cache }));
    inputs.splice(5, 0, { repoRoot: repo, resolvedRepoRoot: repo, inputPath: path.join(path.dirname(file(0)), "Gone.java"), generation: 3 });
    const progress: number[] = [];
    const outcomes = await parseOffThread(inputs, 3, done => progress.push(done));
    const gone = outcomes.splice(5, 1)[0]!;
    assert.ok("error" in gone);
    assert.equal((gone.error as NodeJS.ErrnoException).code, "ENOENT");
    assert.deepEqual(outcomes.map(outcome => "bundle" in outcome ? outcome.bundle : outcome.error), serial);
    assert.deepEqual(progress, Array.from({ length: 31 }, (_, index) => index + 1));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("a large delta parsed on parser threads writes the index a serial delta and a cold build write", async () => {
  const { repo, file } = await fixture();
  const serial = openIndexDb(":memory:"), threaded = openIndexDb(":memory:"), oracle = openIndexDb(":memory:");
  try {
    for (const db of [serial, threaded, oracle]) ensureSchema(db);
    await runSqlColdBuild({ repoRoot: repo, db: serial });
    await runSqlColdBuild({ repoRoot: repo, db: threaded });
    for (let index = 0; index < 28; index++) await writeFile(file(index), source(index, index % 4 ? ".next()" : ""));
    await writeFile(path.join(path.dirname(file(0)), "Added.java"), "package demo;\npublic class Added extends C4 { C9 more() { return null; } }\n");
    await unlink(file(29));
    const changed = [...Array.from({ length: 28 }, (_, index) => file(index)), path.join(path.dirname(file(0)), "Added.java"), file(29)];
    const job = { kind: "refresh" as const, changed, deleted: [] };
    const one = await applyBuilderJob({ repoRoot: repo, db: serial, job, parallelism: 1 });
    const two = await applyBuilderJob({ repoRoot: repo, db: threaded, job, parallelism: 2 });
    assert.equal(one.ok, true, one.error);
    assert.equal(two.ok, true, two.error);
    assert.equal(two.stages?.mode, "delta");
    await runSqlColdBuild({ repoRoot: repo, db: oracle });
    assert.equal(logicalDigest(threaded).digest, logicalDigest(serial).digest, JSON.stringify(diffLogical(exportLogical(threaded), exportLogical(serial))));
    const facts = (db: typeof oracle) => db.prepare("SELECT path, content_hash AS hash FROM file ORDER BY path").all();
    assert.deepEqual(facts(threaded), facts(oracle));
  } finally {
    for (const db of [serial, threaded, oracle]) close(db);
    await rm(repo, { recursive: true, force: true });
  }
});
