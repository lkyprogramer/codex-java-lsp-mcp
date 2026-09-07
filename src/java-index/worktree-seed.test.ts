import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BuilderSupervisor } from "./builder-supervisor.js";
import { runSqlColdBuild } from "./builder/cold-build.js";
import { close, openIndexDb } from "./sql/driver.js";
import { ensureSchema } from "./sql/schema.js";
import { SqlJavaIndexClient } from "./sql/sql-client.js";
import { scanFamilySiblingIndex } from "../repo-layout.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(dirname, "..", "..", "fixtures", "java-index-v2");

async function coldDb(repo: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "iod-seed-db-"));
  const dbPath = path.join(dir, "index.sqlite");
  const db = openIndexDb(dbPath);
  try {
    ensureSchema(db);
    await runSqlColdBuild({ repoRoot: repo, db, generation: 1 });
  } finally {
    close(db);
  }
  return dbPath;
}

test("second family root opens via VACUUM INTO and matches sibling counts", async () => {
  const primaryRepo = await mkdtemp(path.join(tmpdir(), "iod-seed-a-"));
  const secondaryRepo = await mkdtemp(path.join(tmpdir(), "iod-seed-b-"));
  await cp(fixturesRoot, primaryRepo, { recursive: true });
  await cp(fixturesRoot, secondaryRepo, { recursive: true });
  const sibling = await coldDb(primaryRepo);
  const destDir = await mkdtemp(path.join(tmpdir(), "iod-seed-dest-"));
  const dest = path.join(destDir, "index.sqlite");
  const supervisor = new BuilderSupervisor({
    repoRoot: secondaryRepo,
    dbPath: dest,
    idleMs: 5_000,
    stallMs: 30_000
  });
  const client = new SqlJavaIndexClient(secondaryRepo, dest, supervisor, 5_000);
  try {
    const status = await client.open(1, { siblingDbPath: sibling });
    assert.ok(status.files > 0);
    const donor = openIndexDb(sibling, { readOnly: true });
    try {
      const donorFiles = Number((donor.prepare("SELECT count(*) AS n FROM file").get() as { n: number }).n);
      assert.equal(status.files, donorFiles);
    } finally {
      close(donor);
    }
  } finally {
    await client.close();
    await supervisor.stop();
    await rm(primaryRepo, { recursive: true, force: true });
    await rm(secondaryRepo, { recursive: true, force: true });
  }
});

test("scanFamilySiblingIndex picks the newest same-family index.sqlite on disk", async () => {
  const cache = await mkdtemp(path.join(tmpdir(), "iod-family-scan-"));
  const older = path.join(cache, "aaaa");
  const newer = path.join(cache, "bbbb");
  mkdirSync(older);
  mkdirSync(newer);
  writeFileSync(path.join(older, "index.sqlite"), "old");
  await new Promise(resolve => setTimeout(resolve, 20));
  writeFileSync(path.join(newer, "index.sqlite"), "new");
  writeFileSync(path.join(older, "repo-meta.json"), JSON.stringify({ familyHash: "fam", repoHash: "aaaa" }));
  writeFileSync(path.join(newer, "repo-meta.json"), JSON.stringify({ familyHash: "fam", repoHash: "bbbb" }));
  const self = path.join(cache, "cccc", "index.sqlite");
  try {
    assert.equal(scanFamilySiblingIndex(cache, "fam", self), path.join(newer, "index.sqlite"));
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});
