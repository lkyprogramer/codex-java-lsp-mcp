import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { close, openIndexDb } from "./driver.js";
import { ensureSchema } from "./schema.js";
import { attachWorkspaceStat, readStats, recordStats } from "./workspace-stat.js";

const row = { path: "src/main/java/A.java", contentHash: "h1", size: 10, mtimeNs: "1000000123", ctimeNs: "1000000456", ino: "18446744073709551615", dev: "16777234" };

test("a second connection attaching an initialized stat store keeps its rows", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "workspace-stat-"));
  const file = path.join(dir, "index.sqlite");
  const first = openIndexDb(file);
  try {
    ensureSchema(first);
    attachWorkspaceStat(first);
    recordStats(first, "java", [row]);
    const second = openIndexDb(file);
    try {
      attachWorkspaceStat(second);
      assert.deepEqual([...readStats(second, "java").values()], [row]);
    } finally {
      close(second);
    }
  } finally {
    close(first);
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unknown stat layout is dropped and recreated, never migrated", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "workspace-stat-"));
  const file = path.join(dir, "index.sqlite");
  try {
    const old = openIndexDb(file);
    try {
      ensureSchema(old);
      attachWorkspaceStat(old);
      recordStats(old, "java", [row]);
      old.exec("PRAGMA ws.user_version=0");
    } finally {
      close(old);
    }
    const db = openIndexDb(file);
    try {
      attachWorkspaceStat(db);
      assert.equal(readStats(db, "java").size, 0);
      assert.equal((db.prepare("PRAGMA ws.user_version").get() as { user_version: number }).user_version, 2);
    } finally {
      close(db);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stat store whose initialization hits a locked facts DB can be attached again", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "workspace-stat-"));
  const file = path.join(dir, "index.sqlite");
  const holder = openIndexDb(file);
  try {
    ensureSchema(holder);
    const db = openIndexDb(file);
    try {
      db.exec("PRAGMA busy_timeout=0");
      // A fresh store needs its schema created under BEGIN IMMEDIATE, which also reserves main.
      holder.exec("BEGIN IMMEDIATE");
      assert.throws(() => attachWorkspaceStat(db), /locked|busy/i);
      holder.exec("ROLLBACK");
      attachWorkspaceStat(db);
      recordStats(db, "java", [row]);
      assert.equal(readStats(db, "java").size, 1);
    } finally {
      close(db);
    }
  } finally {
    close(holder);
    await rm(dir, { recursive: true, force: true });
  }
});
