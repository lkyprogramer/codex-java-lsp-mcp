import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalPotentialPath, isPotentiallyWithin, isWithin } from "./path-utils.js";

function scratch(): { repo: string; outside: string } {
  // Canonicalize first: on macOS tmpdir is itself a symlink, which would make
  // the isWithin comparison below fail for an unrelated reason.
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "path-utils-")));
  const repo = path.join(base, "repo");
  const outside = path.join(base, "outside");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(repo, "src", "A.java"), "class A {}\n", "utf8");
  writeFileSync(path.join(outside, "Library.java"), "class Library {}\n", "utf8");
  return { repo, outside };
}

test("a real file inside the repo is contained", () => {
  const { repo } = scratch();
  assert.equal(isPotentiallyWithin(repo, path.join(repo, "src", "A.java")), true);
  assert.equal(isPotentiallyWithin(repo, repo), true);
});

test("a real file outside the repo is not contained", () => {
  const { repo, outside } = scratch();
  assert.equal(isPotentiallyWithin(repo, path.join(outside, "Library.java")), false);
});

test("a nonexistent child under a symlink that escapes the repo is not contained", () => {
  const { repo, outside } = scratch();
  symlinkSync(outside, path.join(repo, "link"), "dir");
  const candidate = path.join(repo, "link", "Missing.java");

  // The naive check passes because the path does not exist and never gets
  // resolved through the symlink; this is exactly the gap being closed.
  assert.equal(isWithin(repo, candidate), true, "documents the weaker check");
  assert.equal(isPotentiallyWithin(repo, candidate), false);
});

test("an existing file reached through an escaping symlink is not contained", () => {
  const { repo, outside } = scratch();
  symlinkSync(outside, path.join(repo, "link"), "dir");
  assert.equal(isPotentiallyWithin(repo, path.join(repo, "link", "Library.java")), false);
});

test("a nonexistent file in a real repo directory is still contained", () => {
  const { repo } = scratch();
  assert.equal(isPotentiallyWithin(repo, path.join(repo, "src", "NotYetWritten.java")), true);
});

test("a parent-escaping relative path is not contained", () => {
  const { repo } = scratch();
  assert.equal(isPotentiallyWithin(repo, path.join(repo, "..", "Other.java")), false);
});

test("a sibling directory sharing the repo name prefix is not contained", () => {
  const { repo } = scratch();
  assert.equal(isPotentiallyWithin(repo, `${repo}-other/A.java`), false);
});

test("canonicalPotentialPath resolves the deepest existing ancestor", () => {
  const { repo, outside } = scratch();
  symlinkSync(outside, path.join(repo, "link"), "dir");
  const resolved = canonicalPotentialPath(path.join(repo, "link", "Deep", "Missing.java"));
  assert.equal(resolved.startsWith(canonicalPotentialPath(outside)), true);
  assert.equal(path.basename(resolved), "Missing.java");
});
