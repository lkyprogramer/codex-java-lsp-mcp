import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { prepareOwnerBundle, replaceOwnerBundle, verifyOwnerBundle } from "./managed-owner-launcher.mjs";
import { sha256 } from "./ilv2-mac-contracts.mjs";
import { NATIVE_PROTOCOL, SIGNING_IDENTIFIER } from "./build-macos-native.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "managed-owner-bundle-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = path.join(root, "release");
  await mkdir(path.join(release, "dist/native"), { recursive: true });
  await mkdir(path.join(release, "dist/mac-platform"));
  const runtime = { execPath: "/synthetic/node", nodeSha256: "a".repeat(64), runtimeManifestSha256: "b".repeat(64), versions: { node: "synthetic" }, arch: "arm64" };
  const manifest = { schema: "ilv2-mac-native-build/v1", protocol: NATIVE_PROTOCOL, arch: runtime.arch, binary: "ilv2-mac", binarySha256: sha256("synthetic binary"), runtime,
    signing: { mode: "identity", identifier: SIGNING_IDENTIFIER, teamIdentifier: "SYNTHETIC", designatedRequirement: 'identifier "synthetic" and anchor apple generic' } };
  await writeFile(path.join(release, "dist/native/ilv2-mac"), "synthetic binary");
  await writeFile(path.join(release, "dist/native/manifest.json"), JSON.stringify(manifest));
  for (const name of ["owner-lock-guard", "owner-lock", "clonefile", "native-protocol", "native-exec"]) await writeFile(path.join(release, `dist/mac-platform/${name}.js`), `// synthetic ${name}\n`);
  let signatures = 0;
  const options = { runtime, signatureVerifier: async () => { signatures++; }, capabilityVerifier: async () => ({ protocol: NATIVE_PROTOCOL, arch: runtime.arch }) };
  return { root, release, manifest, options, signatures: () => signatures };
}

test("owner bundle preserves the guard closure and restores a verified predecessor", async t => {
  const f = await fixture(t), fixed = path.join(f.root, "launcher"), candidate = path.join(f.root, "candidate"), backup = path.join(f.root, "backup");
  await prepareOwnerBundle(f.release, fixed, f.options);
  await prepareOwnerBundle(f.release, backup, f.options);
  await writeFile(path.join(f.release, "dist/mac-platform/owner-lock-guard.js"), "// new synthetic guard\n");
  await prepareOwnerBundle(f.release, candidate, f.options);
  await replaceOwnerBundle(candidate, fixed, f.options);
  assert.equal(await readFile(path.join(fixed, "dist/mac-platform/owner-lock-guard.js"), "utf8"), "// new synthetic guard\n");
  await writeFile(path.join(fixed, "dist/native/ilv2-mac"), "damaged installed binary");
  await replaceOwnerBundle(backup, fixed, f.options);
  assert.equal(await readFile(path.join(fixed, "dist/mac-platform/owner-lock-guard.js"), "utf8"), "// synthetic owner-lock-guard\n");
  assert.equal(JSON.parse(await readFile(path.join(fixed, "package.json"))).type, "module");
  assert.ok(f.signatures() >= 5);
});

test("owner bundle rejects digest, identity, runtime and unsafe permission drift before replacement", async t => {
  const f = await fixture(t), candidate = path.join(f.root, "candidate");
  await prepareOwnerBundle(f.release, candidate, f.options);
  const native = path.join(candidate, "dist/native/ilv2-mac"), manifestFile = path.join(candidate, "dist/native/manifest.json");
  await writeFile(native, "tampered");
  await assert.rejects(verifyOwnerBundle(candidate, f.options), /bundle digest mismatch/);
  await writeFile(native, "synthetic binary");
  async function writeManifest(manifest) {
    await writeFile(manifestFile, JSON.stringify(manifest));
    const inventoryFile = path.join(candidate, "bundle-artifacts.json");
    const inventory = JSON.parse(await readFile(inventoryFile));
    inventory.files["dist/native/manifest.json"] = sha256(await readFile(manifestFile));
    await writeFile(inventoryFile, JSON.stringify(inventory));
  }
  await writeManifest({ ...f.manifest, signing: { ...f.manifest.signing, mode: "adhoc" } });
  await assert.rejects(verifyOwnerBundle(candidate, f.options), /stable signing identity/);
  await writeManifest({ ...f.manifest, runtime: { ...f.manifest.runtime, nodeSha256: "changed" } });
  await assert.rejects(verifyOwnerBundle(candidate, f.options), /runtime mismatch/);
  await writeManifest(f.manifest);
  await writeFile(path.join(candidate, "dist/mac-platform/owner-lock-guard.js"), "// stale guard");
  await assert.rejects(verifyOwnerBundle(candidate, f.options), /bundle digest mismatch/);
  await chmod(path.join(candidate, "dist/mac-platform/owner-lock.js"), 0o666);
  await assert.rejects(verifyOwnerBundle(candidate, f.options), /unsafe launcher bundle permissions/);
});
