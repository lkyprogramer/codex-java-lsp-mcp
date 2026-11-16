import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { atomicTmpPath, writeFileAtomic, writeFileAtomicSync } from "./atomic-file.js";

function withDir(fn: (dir: string) => void | Promise<void>) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "atomic-file-"));
    try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}

test("tmp paths sit next to the target and never repeat", () => {
  const a = atomicTmpPath("/x/y/meta.json");
  assert.equal(path.dirname(a), "/x/y");
  assert.match(path.basename(a), /^meta\.json\.tmp-\d+-[0-9a-f-]{36}$/);
  assert.notEqual(a, atomicTmpPath("/x/y/meta.json"));
});

test("sync and async writes replace the target with the given mode and leave no tmp", withDir(async dir => {
  const file = path.join(dir, "meta.json");
  writeFileAtomicSync(file, "one", 0o600);
  assert.equal(readFileSync(file, "utf8"), "one");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  writeFileAtomicSync(file, "两");
  assert.equal(readFileSync(file, "utf8"), "两");
  await writeFileAtomic(file, "three");
  assert.equal(readFileSync(file, "utf8"), "three");
  assert.deepEqual(readdirSync(dir), ["meta.json"]);
}));

test("a failed sync write keeps the old target and removes its tmp", withDir(dir => {
  const target = path.join(dir, "taken");
  mkdirSync(path.join(target, "occupied"), { recursive: true });
  assert.throws(() => writeFileAtomicSync(target, "x"));
  assert.deepEqual(readdirSync(dir), ["taken"]);
  assert.deepEqual(readdirSync(target), ["occupied"]);
}));
