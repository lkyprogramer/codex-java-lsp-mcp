import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeRepoLocation } from "./semantic-location.js";
import { canonicalPath } from "./path-utils.js";

function repoFixture(): string {
  const base = mkdtempSync(path.join(tmpdir(), "semantic-location-"));
  const repo = path.join(base, "repo");
  mkdirSync(path.join(repo, "src", "main", "java", "demo"), { recursive: true });
  writeFileSync(path.join(repo, "src", "main", "java", "demo", "A.java"), "class A {}\n", "utf8");
  return canonicalPath(repo);
}

function locationFor(file: string, startLine = 4, startCharacter = 2): { uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } } {
  return {
    uri: pathToFileURL(file).toString(),
    range: {
      start: { line: startLine, character: startCharacter },
      end: { line: startLine, character: startCharacter + 1 }
    }
  };
}

test("semantic locations outside canonical repo root are rejected", () => {
  const repo = repoFixture();
  const external = path.join(tmpdir(), "dependency", "Library.java");
  const value = normalizeRepoLocation(repo, {
    uri: pathToFileURL(external).toString(),
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 5 }
    }
  });
  assert.equal(value, undefined);
});

test("repo locations are returned as relative 1-based ranges", () => {
  const repo = repoFixture();
  const file = path.join(repo, "src/main/java/demo/A.java");
  const value = normalizeRepoLocation(repo, locationFor(file));
  assert.deepEqual(value, {
    absolutePath: file,
    relativePath: "src/main/java/demo/A.java",
    range: {
      start: { line: 5, column: 3 },
      end: { line: 5, column: 4 }
    }
  });
});

test("the returned absolutePath stays in the caller's repoRoot namespace", () => {
  const canonicalRepo = repoFixture();
  const base = mkdtempSync(path.join(tmpdir(), "semantic-alias-"));
  const aliasRepo = path.join(base, "alias");
  symlinkSync(canonicalRepo, aliasRepo, "dir");

  const value = normalizeRepoLocation(aliasRepo, locationFor(path.join(canonicalRepo, "src/main/java/demo/A.java")));
  assert.equal(value?.relativePath, "src/main/java/demo/A.java");
  assert.equal(
    value?.absolutePath,
    path.join(aliasRepo, "src/main/java/demo/A.java"),
    "caches and edge records must key on the caller's root, not the canonical one"
  );
});

test("a Maven repository jar source is rejected", () => {
  const repo = repoFixture();
  const jarSource = path.join(homedir(), ".m2", "repository", "org", "example", "Lib.java");
  assert.equal(normalizeRepoLocation(repo, locationFor(jarSource)), undefined);
});

test("a JDK source location is rejected", () => {
  const repo = repoFixture();
  const jdkSource = "/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/lib/src/String.java";
  assert.equal(normalizeRepoLocation(repo, locationFor(jdkSource)), undefined);
});

test("a location reached through a symlink out of the repo is rejected", () => {
  const repo = repoFixture();
  const outside = mkdtempSync(path.join(tmpdir(), "semantic-outside-"));
  writeFileSync(path.join(outside, "External.java"), "class External {}\n", "utf8");
  symlinkSync(outside, path.join(repo, "link"), "dir");

  assert.equal(normalizeRepoLocation(repo, locationFor(path.join(repo, "link", "External.java"))), undefined);
  assert.equal(normalizeRepoLocation(repo, locationFor(path.join(repo, "link", "Missing.java"))), undefined);
});

test("a LocationLink uses its target selection range", () => {
  const repo = repoFixture();
  const file = path.join(repo, "src/main/java/demo/A.java");
  const value = normalizeRepoLocation(repo, {
    targetUri: pathToFileURL(file).toString(),
    targetRange: { start: { line: 0, character: 0 }, end: { line: 9, character: 0 } },
    targetSelectionRange: { start: { line: 1, character: 6 }, end: { line: 1, character: 7 } }
  });
  assert.deepEqual(value?.range, {
    start: { line: 2, column: 7 },
    end: { line: 2, column: 8 }
  });
});

test("a non-file uri is rejected", () => {
  const repo = repoFixture();
  const value = normalizeRepoLocation(repo, {
    uri: "jdt://contents/rt.jar/java.lang/String.class",
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
  });
  assert.equal(value, undefined);
});

test("the repo root itself is not a location", () => {
  const repo = repoFixture();
  assert.equal(normalizeRepoLocation(repo, locationFor(repo)), undefined);
});
