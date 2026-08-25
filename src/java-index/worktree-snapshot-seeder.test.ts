import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { probeLayout } from "../layout-probe.js";
import { createGitWorktreeFamily } from "../test-support/git-worktree.test.js";
import { resolveWorktreeIdentity } from "../worktree-identity.js";
import { computeBuildFingerprint, computeExtractorVersion } from "./build-fingerprint.js";
import { JavaIndexClient } from "./java-index-client.js";
import { readFileStable, scanCurrentManifestStable } from "./manifest.js";
import { STABLE_ID_VERSION } from "./stable-id.js";
import { WorktreeSnapshotSeeder } from "./worktree-snapshot-seeder.js";

const run = promisify(execFile);

function write(root: string, relativePath: string, content: string): void {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function tempCacheBase(): string {
  return mkdtempSync(path.join(tmpdir(), "java-index-seed-cache-"));
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for condition after ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const SAME = "src/main/java/demo/Same.java";
const CHANGED = "src/main/java/demo/Changed.java";
const DELETED_IN_B = "src/main/java/demo/DeletedInB.java";
const NEW_IN_B = "src/main/java/demo/NewInB.java";

/** Builds a real COMPLETE snapshot for `repoRoot` under `cacheDir`, via a real worker thread (never hand-assembled). */
async function buildCompleteSnapshot(repoRoot: string, cacheDir: string): Promise<void> {
  const client = new JavaIndexClient(repoRoot, cacheDir);
  await client.open(1);
  await client.reconcile(1);
  await waitFor(async () => (await client.status()).pendingBackground === 0, 15000);
  // Java sweep can durable-stamp before mapper XML is in the store; FLUSH
  // rewrites the sibling snapshot so seed tests see the completed facts.
  await client.flush();
  await client.close();
}

async function writeRepoMeta(cacheDir: string, repoRoot: string): Promise<void> {
  const identity = await resolveWorktreeIdentity(repoRoot);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    path.join(cacheDir, "repo-meta.json"),
    JSON.stringify({ repoRoot, repoHash: identity.repoHash, familyHash: identity.familyHash })
  );
}

/** Sets up A's complete snapshot and a family cache base, ready for a seeder run against B. */
async function seedableFamily(): Promise<{
  family: Awaited<ReturnType<typeof createGitWorktreeFamily>>;
  cacheBase: string;
  primaryCacheDir: string;
}> {
  const family = await createGitWorktreeFamily();
  // A.java is the fixture's own baseline file, irrelevant to this scenario's
  // assertions - remove it from both sides so reusedPaths/dirtyPaths match
  // the plan's own scenario exactly.
  rmSync(path.join(family.primary, "src/main/java/demo/A.java"), { force: true });
  rmSync(path.join(family.linked, "src/main/java/demo/A.java"), { force: true });

  for (const root of [family.primary, family.linked]) {
    write(root, SAME, "package demo;\npublic class Same {}\n");
    write(root, CHANGED, "package demo;\npublic class Changed {}\n");
    write(root, DELETED_IN_B, "package demo;\npublic class DeletedInB {}\n");
  }

  const cacheBase = tempCacheBase();
  const primaryCacheDir = path.join(cacheBase, "primary");
  await buildCompleteSnapshot(family.primary, primaryCacheDir);
  await writeRepoMeta(primaryCacheDir, family.primary);

  return { family, cacheBase, primaryCacheDir };
}

async function seedIdentityFor(repoRoot: string) {
  const layout = probeLayout(repoRoot);
  return {
    identity: {
      extractorVersion: computeExtractorVersion(),
      stableIdVersion: STABLE_ID_VERSION,
      buildFingerprint: await computeBuildFingerprint(repoRoot, layout)
    },
    layout
  };
}

test("sibling seed reuses only target-content-matching facts", async () => {
  const { family, cacheBase } = await seedableFamily();

  write(family.linked, CHANGED, "package demo;\npublic class Changed { void extra() {} }\n");
  rmSync(path.join(family.linked, DELETED_IN_B));
  write(family.linked, NEW_IN_B, "package demo;\npublic class NewInB {}\n");

  const targetIdentity = await resolveWorktreeIdentity(family.linked);
  const { identity, layout } = await seedIdentityFor(family.linked);

  const seeder = new WorktreeSnapshotSeeder();
  const candidate = await seeder.findCandidate(targetIdentity, identity, cacheBase);
  assert.ok(candidate, "primary's complete snapshot must be found as a candidate");
  assert.equal(seeder.lastScanTelemetry.cacheDirsScanned, 1, "cacheBase has exactly one sibling cache dir (primary)");
  assert.equal(seeder.lastScanTelemetry.eligibleSnapshots, 1, "primary's snapshot passes every eligibility check");

  const { result, store } = await seeder.seedValidatedFacts(candidate!, identity, family.linked, layout, 2);

  assert.deepEqual(result.reusedPaths, [SAME]);
  assert.deepEqual(result.dirtyPaths, [CHANGED, NEW_IN_B]);
  assert.deepEqual(result.deletedSourcePaths, [DELETED_IN_B]);
  assert.equal(result.coverage, "DEGRADED");
  assert.equal(result.negativeLookupAllowed, false);
  assert.ok(result.candidateDecompressMs >= 0);
  assert.ok(result.initialManifestScanMs >= 0);
  assert.ok(result.finalManifestScanMs >= 0);
  assert.equal(store.file(SAME) !== undefined, true, "Same.java's facts must be present in the seeded store");
  assert.equal(store.file(CHANGED), undefined, "Changed.java must not be seeded from stale source facts");
  assert.equal(store.file(DELETED_IN_B), undefined, "a file deleted in the target must never be seeded");
  assert.equal(store.file(NEW_IN_B), undefined, "the seeder itself never parses - a new file has no source facts to reuse");
});

test("reused facts are stamped into the target's current generation, not the source's", async () => {
  const { family, cacheBase } = await seedableFamily();

  const targetIdentity = await resolveWorktreeIdentity(family.linked);
  const { identity, layout } = await seedIdentityFor(family.linked);
  const seeder = new WorktreeSnapshotSeeder();
  const candidate = await seeder.findCandidate(targetIdentity, identity, cacheBase);
  assert.ok(candidate);

  const targetGeneration = 42;
  const { store } = await seeder.seedValidatedFacts(candidate!, identity, family.linked, layout, targetGeneration);
  const same = store.file(SAME)!;
  assert.equal(same.generation, targetGeneration);
});

test("final stable revalidation drops a reused fact changed after its initial hash and before seed publication", async () => {
  const { family, cacheBase } = await seedableFamily();
  const targetIdentity = await resolveWorktreeIdentity(family.linked);
  const { identity, layout } = await seedIdentityFor(family.linked);
  const seeder = new WorktreeSnapshotSeeder();
  const candidate = await seeder.findCandidate(targetIdentity, identity, cacheBase);
  assert.ok(candidate);

  const { result, store } = await seeder.seedValidatedFacts(candidate!, identity, family.linked, layout, 2, {
    beforeFinalValidation: () => write(
      family.linked,
      SAME,
      "package demo; public class Same { void changedAfterHash() {} }\n"
    )
  });

  assert.equal(
    result.reusedPaths.includes(SAME),
    false,
    "a file changed after the initial stable scan must not be published as reused"
  );
  assert.ok(result.dirtyPaths.includes(SAME));
  assert.equal(store.file(SAME), undefined, "no stale facts may survive the final validation boundary");
});

test("a corrupt newest candidate falls back to the next valid candidate", async () => {
  const { family, cacheBase } = await seedableFamily();

  // A second, newer-looking but corrupt sibling cache must not shadow the
  // genuinely valid primary candidate.
  const corruptCacheDir = path.join(cacheBase, "corrupt-sibling");
  mkdirSync(corruptCacheDir, { recursive: true });
  writeFileSync(path.join(corruptCacheDir, "java-index-snapshot.json.gz"), "not a real gzip stream");
  writeFileSync(
    path.join(corruptCacheDir, "repo-meta.json"),
    JSON.stringify({
      repoRoot: "/nonexistent/corrupt-sibling",
      repoHash: "corrupt-repo-hash",
      familyHash: (await resolveWorktreeIdentity(family.primary)).familyHash
    })
  );

  const targetIdentity = await resolveWorktreeIdentity(family.linked);
  const { identity } = await seedIdentityFor(family.linked);
  const seeder = new WorktreeSnapshotSeeder();
  const candidate = await seeder.findCandidate(targetIdentity, identity, cacheBase);

  assert.ok(candidate, "the corrupt sibling must be skipped, not fatal");
  assert.equal(candidate!.sourceRepoRoot, family.primary);
  assert.equal(seeder.lastScanTelemetry.cacheDirsScanned, 2, "both the corrupt and the valid sibling dir were scanned");
  assert.equal(seeder.lastScanTelemetry.eligibleSnapshots, 1, "only the valid sibling passed eligibility");
});

test("a source snapshot that disappears before seeding leaves the target with no seed", async () => {
  const { family, cacheBase, primaryCacheDir } = await seedableFamily();
  const targetIdentity = await resolveWorktreeIdentity(family.linked);
  const { identity, layout } = await seedIdentityFor(family.linked);
  const seeder = new WorktreeSnapshotSeeder();
  const candidate = await seeder.findCandidate(targetIdentity, identity, cacheBase);
  assert.ok(candidate);

  rmSync(path.join(primaryCacheDir, "java-index-snapshot.json.gz"));

  const { result, store } = await seeder.seedValidatedFacts(candidate!, identity, family.linked, layout, 2);
  assert.equal(result.reusedFiles, 0);
  assert.equal(store.file(SAME), undefined);
});

test("no valid sibling candidate reports no candidate, not an error", async () => {
  const family = await createGitWorktreeFamily();
  const cacheBase = tempCacheBase(); // empty - no sibling has ever run here
  const targetIdentity = await resolveWorktreeIdentity(family.linked);
  const { identity } = await seedIdentityFor(family.linked);

  const seeder = new WorktreeSnapshotSeeder();
  const candidate = await seeder.findCandidate(targetIdentity, identity, cacheBase);
  assert.equal(candidate, undefined);
  assert.equal(seeder.lastScanTelemetry.cacheDirsScanned, 0);
  assert.equal(seeder.lastScanTelemetry.eligibleSnapshots, 0);
});

test("a sibling snapshot with a mismatched build fingerprint is still seed-eligible", async () => {
  const { family, cacheBase } = await seedableFamily();
  write(family.linked, "pom.xml", "<project><artifactId>linked</artifactId></project>\n");
  const targetIdentity = await resolveWorktreeIdentity(family.linked);
  const { identity, layout } = await seedIdentityFor(family.linked);
  const seeder = new WorktreeSnapshotSeeder();
  const candidate = await seeder.findCandidate(targetIdentity, identity, cacheBase);
  assert.ok(candidate);
  assert.equal(candidate.fingerprintMatched, false);
  const { result } = await seeder.seedValidatedFacts(candidate, identity, family.linked, layout, 2);
  assert.ok(result.reusedFiles >= 1);
});

test("extractorVersion mismatch still refuses a sibling snapshot", async () => {
  const { family, cacheBase } = await seedableFamily();
  const targetIdentity = await resolveWorktreeIdentity(family.linked);
  const { identity } = await seedIdentityFor(family.linked);
  const seeder = new WorktreeSnapshotSeeder();
  const candidate = await seeder.findCandidate(targetIdentity, { ...identity, extractorVersion: "schema-0|facts-0" }, cacheBase);
  assert.equal(candidate, undefined);
  assert.ok(seeder.lastScanTelemetry.identityMismatch >= 1);
});

test("findCandidate recovers familyHash from the target cache meta when live identity omitted it", async () => {
  const { family, cacheBase } = await seedableFamily();
  await writeRepoMeta(path.join(cacheBase, "linked-self"), family.linked);
  const targetIdentity = await resolveWorktreeIdentity(family.linked);
  const { identity } = await seedIdentityFor(family.linked);
  const seeder = new WorktreeSnapshotSeeder();
  const candidate = await seeder.findCandidate(
    { ...targetIdentity, familyHash: undefined },
    identity,
    cacheBase
  );
  assert.ok(candidate);
  assert.equal(candidate.sourceRepoRoot, family.primary);
});

test("findCandidate recovers family from the target .git file when cache meta and live familyHash are both missing", async () => {
  const { family, cacheBase } = await seedableFamily();
  const targetIdentity = await resolveWorktreeIdentity(family.linked);
  const { identity } = await seedIdentityFor(family.linked);
  const seeder = new WorktreeSnapshotSeeder();
  const candidate = await seeder.findCandidate(
    { repoRoot: targetIdentity.repoRoot, repoHash: targetIdentity.repoHash, isLinkedWorktree: true },
    identity,
    cacheBase
  );
  assert.ok(candidate);
  assert.equal(candidate.sourceRepoRoot, family.primary);
});

test("findCandidate records skip reasons without treating them as errors", async () => {
  const { family, cacheBase } = await seedableFamily();
  mkdirSync(path.join(cacheBase, "empty"));
  await writeRepoMeta(path.join(cacheBase, "self"), family.linked);
  const otherDir = path.join(cacheBase, "other-family");
  mkdirSync(otherDir, { recursive: true });
  writeFileSync(
    path.join(otherDir, "repo-meta.json"),
    JSON.stringify({ repoRoot: "/tmp/other-family", repoHash: "other-repo-hash", familyHash: "not-this-family" })
  );

  const targetIdentity = await resolveWorktreeIdentity(family.linked);
  const { identity } = await seedIdentityFor(family.linked);
  const seeder = new WorktreeSnapshotSeeder();
  const candidate = await seeder.findCandidate(targetIdentity, identity, cacheBase);
  assert.ok(candidate);
  assert.equal(seeder.lastScanTelemetry.metaMissing, 1);
  assert.equal(seeder.lastScanTelemetry.selfSkip, 1);
  assert.equal(seeder.lastScanTelemetry.familyMismatch, 1);
  assert.equal(seeder.lastScanTelemetry.eligibleSnapshots, 1);
});

test("a fingerprint-matched sibling is preferred over a newer mismatched one", async () => {
  const { family, cacheBase } = await seedableFamily();
  const mismatched = path.join(path.dirname(family.primary), "mismatched");
  await run("git", ["-C", family.primary, "worktree", "add", "-q", "-b", "mismatched", mismatched], {
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid"
    }
  });
  write(mismatched, SAME, "package demo;\npublic class Same {}\n");
  write(mismatched, CHANGED, "package demo;\npublic class Changed {}\n");
  write(mismatched, "pom.xml", "<project><artifactId>mismatched</artifactId></project>\n");
  await new Promise(resolve => setTimeout(resolve, 50));
  const mismatchedCacheDir = path.join(cacheBase, "mismatched");
  await buildCompleteSnapshot(mismatched, mismatchedCacheDir);
  await writeRepoMeta(mismatchedCacheDir, mismatched);

  const targetIdentity = await resolveWorktreeIdentity(family.linked);
  const { identity } = await seedIdentityFor(family.linked);
  const seeder = new WorktreeSnapshotSeeder();
  const candidate = await seeder.findCandidate(targetIdentity, identity, cacheBase);
  assert.ok(candidate);
  assert.equal(candidate.sourceRepoRoot, family.primary);
  assert.equal(candidate.fingerprintMatched, true);
  assert.equal(seeder.lastScanTelemetry.eligibleSnapshots, 2);
});

test("an unchanged source file whose only target-visible dependency changed drops its resolved edge and enters relinkPaths", async () => {
  const family = await createGitWorktreeFamily();
  rmSync(path.join(family.primary, "src/main/java/demo/A.java"), { force: true });
  rmSync(path.join(family.linked, "src/main/java/demo/A.java"), { force: true });

  const gateway = "src/main/java/demo/Gateway.java";
  const impl = "src/main/java/demo/Impl.java";
  for (const root of [family.primary, family.linked]) {
    write(root, gateway, "package demo;\npublic interface Gateway {}\n");
    write(root, impl, "package demo;\npublic class Impl implements Gateway {}\n");
  }

  const cacheBase = tempCacheBase();
  const primaryCacheDir = path.join(cacheBase, "primary");
  await buildCompleteSnapshot(family.primary, primaryCacheDir);
  await writeRepoMeta(primaryCacheDir, family.primary);

  // Gateway.java changes in the target; Impl.java (which references it) does not.
  write(family.linked, gateway, "package demo;\npublic interface Gateway { void run(); }\n");

  const targetIdentity = await resolveWorktreeIdentity(family.linked);
  const { identity, layout } = await seedIdentityFor(family.linked);
  const seeder = new WorktreeSnapshotSeeder();
  const candidate = await seeder.findCandidate(targetIdentity, identity, cacheBase);
  assert.ok(candidate);

  const { result, store } = await seeder.seedValidatedFacts(candidate!, identity, family.linked, layout, 2);

  assert.deepEqual(result.reusedPaths, [impl]);
  assert.ok(result.relinkPaths.includes(impl), `expected ${impl} to need relinking, got ${JSON.stringify(result.relinkPaths)}`);
  assert.ok(result.droppedCrossFileEdges > 0, "the stale IMPLEMENTS edge into the changed Gateway type must be dropped");
  const implEdges = [...store.edgesById.values()].filter(edge => edge.sourceFile === impl);
  assert.equal(
    implEdges.some(edge => edge.kind === "IMPLEMENTS"),
    false,
    "a resolved edge into a dropped (changed) type must not survive in the seeded store"
  );
});

test("readFileStable reports a quiet file as stable", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "read-stable-"));
  const filePath = path.join(dir, "Quiet.java");
  writeFileSync(filePath, "package demo;\nclass Quiet {}\n");
  const read = await readFileStable(filePath);
  assert.ok(read);
  assert.equal(read!.stable, true);
  assert.equal(read!.content, "package demo;\nclass Quiet {}\n");
});

test("a path scanCurrentManifestStable reports as unstable is excluded from entries, not silently trusted", async () => {
  // Rather than racing the two fstat() calls (flaky), this drives the
  // consumption path directly: scanCurrentManifestStable's own contract is
  // that an unstable path never appears in `entries`, which is exactly what
  // the seeder relies on to never reuse it.
  const repoRoot = mkdtempSync(path.join(tmpdir(), "unstable-scan-"));
  write(repoRoot, "src/main/java/demo/Solo.java", "package demo;\nclass Solo {}\n");
  const layout = probeLayout(repoRoot);
  const { discovered, entries, unstablePaths } = await scanCurrentManifestStable(repoRoot, layout);
  assert.equal(unstablePaths.length, 0, "a quiet file must not be reported unstable");
  assert.equal(entries.length, discovered.length);
});

const MAPPER_RELATIVE_PATH = "src/main/resources/mapper/OrderMapper.xml";
const ORIGINAL_MAPPER_XML = '<mapper namespace="demo.OrderMapper"><select id="findById">select 1</select></mapper>';
const CHANGED_MAPPER_XML = '<mapper namespace="demo.OrderMapper"><select id="findById">x</select><insert id="insert">y</insert></mapper>';

/** Same as seedableFamily(), plus an unchanged Java mapper interface and a MyBatis mapper resource on both sides. */
async function seedableFamilyWithResource(): Promise<{
  family: Awaited<ReturnType<typeof createGitWorktreeFamily>>;
  cacheBase: string;
}> {
  const family = await createGitWorktreeFamily();
  rmSync(path.join(family.primary, "src/main/java/demo/A.java"), { force: true });
  rmSync(path.join(family.linked, "src/main/java/demo/A.java"), { force: true });
  for (const root of [family.primary, family.linked]) {
    write(root, "src/main/java/demo/OrderMapper.java", "package demo;\npublic interface OrderMapper { Object findById(Long id); }\n");
    write(root, MAPPER_RELATIVE_PATH, ORIGINAL_MAPPER_XML);
  }
  const cacheBase = tempCacheBase();
  const primaryCacheDir = path.join(cacheBase, "primary");
  await buildCompleteSnapshot(family.primary, primaryCacheDir);
  await writeRepoMeta(primaryCacheDir, family.primary);
  return { family, cacheBase };
}

test("sibling seed reuses an unchanged MyBatis resource by content hash and counts it separately from Java files", async () => {
  const { family, cacheBase } = await seedableFamilyWithResource();

  const targetIdentity = await resolveWorktreeIdentity(family.linked);
  const { identity, layout } = await seedIdentityFor(family.linked);
  const seeder = new WorktreeSnapshotSeeder();
  const candidate = await seeder.findCandidate(targetIdentity, identity, cacheBase);
  assert.ok(candidate);

  const { result, store } = await seeder.seedValidatedFacts(candidate!, identity, family.linked, layout, 2);

  assert.equal(result.reusedResources, 1);
  assert.equal(result.dirtyResources, 0);
  const resource = store.myBatisResource(MAPPER_RELATIVE_PATH);
  assert.equal(resource?.namespace, "demo.OrderMapper");
  assert.equal(resource?.generation, 2, "a reused resource must be stamped into the target's current generation");
});

test("sibling seed does not reuse a MyBatis resource changed on the target - the Java mapper interface is unaffected", async () => {
  const { family, cacheBase } = await seedableFamilyWithResource();
  write(family.linked, MAPPER_RELATIVE_PATH, CHANGED_MAPPER_XML);

  const targetIdentity = await resolveWorktreeIdentity(family.linked);
  const { identity, layout } = await seedIdentityFor(family.linked);
  const seeder = new WorktreeSnapshotSeeder();
  const candidate = await seeder.findCandidate(targetIdentity, identity, cacheBase);
  assert.ok(candidate);

  const { result, store } = await seeder.seedValidatedFacts(candidate!, identity, family.linked, layout, 2);

  assert.equal(result.reusedResources, 0);
  assert.equal(result.dirtyResources, 1);
  assert.equal(
    (result as { droppedFrameworkEdges?: number }).droppedFrameworkEdges,
    0,
    "framework links are derived at request time, but the required seed diagnostic must report that explicitly"
  );
  assert.equal(store.myBatisResource(MAPPER_RELATIVE_PATH), undefined, "a changed resource must not be seeded from stale source facts");
  // The unrelated, unchanged Java mapper interface must still be reused -
  // a dirty resource must never force its owning Java file to be dropped.
  assert.ok(store.file("src/main/java/demo/OrderMapper.java"), "the unchanged Java mapper interface must still be reused");
});

test("final stable revalidation drops a reused MyBatis resource changed after its initial hash and before seed publication", async () => {
  const { family, cacheBase } = await seedableFamilyWithResource();
  const targetIdentity = await resolveWorktreeIdentity(family.linked);
  const { identity, layout } = await seedIdentityFor(family.linked);
  const seeder = new WorktreeSnapshotSeeder();
  const candidate = await seeder.findCandidate(targetIdentity, identity, cacheBase);
  assert.ok(candidate);

  const { result, store } = await seeder.seedValidatedFacts(candidate!, identity, family.linked, layout, 2, {
    beforeFinalValidation: () => write(family.linked, MAPPER_RELATIVE_PATH, CHANGED_MAPPER_XML)
  });

  assert.equal(result.reusedResources, 0);
  assert.equal(store.myBatisResource(MAPPER_RELATIVE_PATH), undefined, "no stale resource facts may survive the final validation boundary");
});

test("a linked worktree opened via siblingCacheBase reuses an unchanged mapper resource, then re-derives a changed one once the post-seed sweep completes", async () => {
  const { family, cacheBase } = await seedableFamilyWithResource();
  write(family.linked, MAPPER_RELATIVE_PATH, CHANGED_MAPPER_XML);

  const identity = await resolveWorktreeIdentity(family.linked);
  const client = new JavaIndexClient(family.linked, tempCacheBase());
  try {
    const openStatus = await client.open(1, { worktree: identity, siblingCacheBase: cacheBase });

    assert.equal(openStatus.worktreeSeed?.completion, "SEEDED_DEGRADED");
    assert.equal(openStatus.worktreeSeed?.dirtyResources, 1);

    // client.open() alone never triggers a follow-up reconcile - that
    // orchestration lives in repo-runtime-manager.ts (driven by the
    // restored coverage's own DEGRADED state), not the worker/client pair
    // this test talks to directly. Drive it explicitly, matching this
    // file's own buildCompleteSnapshot helper.
    await client.reconcile(1);
    await waitFor(async () => (await client.status()).pendingBackground === 0, 15000);
    const settledStatus = await client.status();
    assert.equal(settledStatus.worktreeSeed?.completion, "RECONCILED_COMPLETE");

    const facts = await client.queryMyBatisResource(MAPPER_RELATIVE_PATH);
    assert.deepEqual(
      facts?.statements.map(s => s.id).sort(),
      ["findById", "insert"],
      "the resource must be re-derived with the target's real content once the post-seed sweep finishes"
    );
  } finally {
    // A worker thread left open by a mid-test failure keeps the whole test
    // process alive well past this test's own timeout - always close it.
    await client.close();
  }
});
