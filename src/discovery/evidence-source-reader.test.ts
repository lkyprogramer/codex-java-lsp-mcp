// input: temporary files under a realpath'd root.
// output: post-ILV2 Q04 checks for the shared bounded source reader (05 §5.4).
// pos: the one safety implementation used by evidence and outline.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DeadlineBudget } from "../runtime/deadline-budget.js";
import { readVerifiedEvidenceFile } from "./evidence-source-reader.js";

const hash = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
const SOURCE = "package demo;\r\n// 订单\r\nclass A {}\n";

async function root(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "evidence-reader-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src/A.java"), SOURCE);
  return dir;
}

const reason = (promise: Promise<unknown>) => promise.then(() => "READ", (error: Error) => error.message);

test("reads the exact bytes with their hash; CRLF and UTF-8 kept", async t => {
  const dir = await root(t);
  const read = await readVerifiedEvidenceFile({ root: dir, relativePath: "src/A.java", expectedHash: hash(SOURCE) });
  assert.equal(read.text, SOURCE);
  assert.equal(read.contentHash, hash(SOURCE));
  assert.deepEqual(Buffer.from(read.bytes), Buffer.from(SOURCE, "utf8"));
});

test("new bytes are never returned under an old hash", async t => {
  const dir = await root(t);
  assert.equal(await reason(readVerifiedEvidenceFile({ root: dir, relativePath: "src/A.java", expectedHash: hash("older") })), "SOURCE_STALE");
});

test("outside paths, symlinks out of the root, caps and invalid UTF-8 are refused with stable reasons", async t => {
  const dir = await root(t);
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), "evidence-reader-outside-")));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "B.java"), SOURCE);
  await symlink(path.join(outside, "B.java"), path.join(dir, "src/B.java"));
  assert.equal(await reason(readVerifiedEvidenceFile({ root: dir, relativePath: "../x/B.java", expectedHash: hash(SOURCE) })), "SOURCE_OUTSIDE_REPO");
  assert.equal(await reason(readVerifiedEvidenceFile({ root: dir, relativePath: path.join(outside, "B.java"), expectedHash: hash(SOURCE) })), "SOURCE_OUTSIDE_REPO");
  assert.equal(await reason(readVerifiedEvidenceFile({ root: dir, relativePath: "src/B.java", expectedHash: hash(SOURCE) })), "SOURCE_OUTSIDE_REPO");
  assert.equal(await reason(readVerifiedEvidenceFile({ root: dir, relativePath: "src/A.java", expectedHash: hash(SOURCE), maxFileBytes: 8 })), "SOURCE_FILE_CAP");
  assert.equal(await reason(readVerifiedEvidenceFile({ root: dir, relativePath: "src", expectedHash: hash(SOURCE) })), "SOURCE_NOT_FILE");
  const invalid = Buffer.from([0x63, 0x6c, 0xff, 0x0a]);
  await writeFile(path.join(dir, "src/C.java"), invalid);
  assert.equal(await reason(readVerifiedEvidenceFile({ root: dir, relativePath: "src/C.java", expectedHash: hash(invalid) })), "SOURCE_NOT_UTF8");
});

test("an exhausted deadline stops the read with DEADLINE_EXCEEDED, not a partial text", async t => {
  const dir = await root(t);
  const budget = { remainingMs: () => 0 } as unknown as DeadlineBudget;
  assert.equal(await reason(readVerifiedEvidenceFile({ root: dir, relativePath: "src/A.java", expectedHash: hash(SOURCE), budget })), "DEADLINE_EXCEEDED");
});
