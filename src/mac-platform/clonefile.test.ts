import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { callMacNative, cloneSealedDatabase, readMacNativeIdentity } from "./clonefile.js";

test("same-volume-clone-or-explicit-error", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mac-clone-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "sealed.db"), target = path.join(root, "private.db");
  const bytes = Buffer.from("sealed synthetic database bytes\n");
  await writeFile(source, bytes);
  const capability = await callMacNative(["capability", root]);
  if (!capability.apfs) { await assert.rejects(cloneSealedDatabase(source, target, root), /APFS_REQUIRED/); return; }
  await cloneSealedDatabase(source, target, root);
  assert.deepEqual(await readFile(target), bytes);
  await writeFile(target, "private mutation");
  assert.deepEqual(await readFile(source), bytes);
  await assert.rejects(cloneSealedDatabase(source, target, root), /CLONE_FAILED/);
  assert.equal(await readFile(target, "utf8"), "private mutation");
  const outside = path.join(root, "other");
  await mkdir(outside);
  await assert.rejects(cloneSealedDatabase(source, path.join(outside, "escape.db"), outside), /cache root/);
});

test("native identity rejects architecture, runtime and binary drift", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mac-native-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(fileURLToPath(new URL("../native/", import.meta.url)), root, { recursive: true });
  const file = path.join(root, "manifest.json");
  const original = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...original, arch: "wrong" }));
  await assert.rejects(readMacNativeIdentity(root), /identity mismatch/);
  await writeFile(file, JSON.stringify({ ...original, runtime: { ...original.runtime, nodeSha256: "wrong" } }));
  await assert.rejects(readMacNativeIdentity(root), /runtime mismatch/);
  await writeFile(file, JSON.stringify(original));
  await writeFile(path.join(root, "ilv2-mac"), "invalid binary");
  await assert.rejects(readMacNativeIdentity(root), /binary digest mismatch/);
});
