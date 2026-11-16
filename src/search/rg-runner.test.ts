import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RgRunner } from "./rg-runner.js";
import { DeadlineBudget } from "../runtime/deadline-budget.js";
import type { RgQuery } from "./search-types.js";

/**
 * Builds a Node script that impersonates `rg --json`. Each entry is either a
 * literal stdout line, `__SLEEP_<ms>__`, `__STDERR_<text>__`, or `__EXIT_<n>__`.
 */
function writeFakeRgScript(lines: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-rg-"));
  const script = path.join(dir, "fake-rg.mjs");
  writeFileSync(script, `
const steps = ${JSON.stringify(lines)};
let exitCode = 0;
for (const step of steps) {
  const sleep = /^__SLEEP_(\\d+)__$/.exec(step);
  const err = /^__STDERR_(.*)__$/.exec(step);
  const exit = /^__EXIT_(\\d+)__$/.exec(step);
  if (sleep) {
    await new Promise(resolve => setTimeout(resolve, Number(sleep[1])));
    continue;
  }
  if (err) {
    process.stderr.write(err[1].repeat(200) + "\\n");
    continue;
  }
  if (exit) {
    exitCode = Number(exit[1]);
    continue;
  }
  await new Promise(resolve => process.stdout.write(step + "\\n", resolve));
}
process.exit(exitCode);
`, "utf8");
  return script;
}

function matchLine(file: string, line = 1, start = 6): string {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: file },
      lines: { text: "class A {}\n" },
      line_number: line,
      submatches: [{ start, end: start + 1, match: { text: "A" } }]
    }
  });
}

function repoWithFile(relative: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "rg-repo-"));
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "class A {}\n", "utf8");
  return root;
}

function query(root: string, pattern = "A"): RgQuery {
  return { pattern, roots: [root], globs: ["*.java"], cwd: root };
}

function fakeRunner(script: string, options: Record<string, unknown> = {}): RgRunner {
  return new RgRunner({ binary: process.execPath, prefixArgs: [script], ...options });
}

test("rg timeout returns partial evidence but is not complete", async () => {
  const root = repoWithFile("src/main/java/demo/A.java");
  const script = await writeFakeRgScript([
    matchLine("src/main/java/demo/A.java"),
    "__SLEEP_2000__"
  ]);
  const runner = fakeRunner(script);
  // Leave enough process-start headroom for this to remain a timeout-semantics
  // test under concurrent CI load. The fake rg has already emitted one match
  // and then sleeps for two seconds, so 800 ms still deterministically exercises
  // the timeout path without depending on a sub-100 ms Node startup.
  const result = await runner.run(query(root), DeadlineBudget.fromTimeout(800));

  assert.equal(result.completion, "PARTIAL_TIMEOUT");
  assert.equal(result.errorCode, "SEARCH_TIMEOUT");
  assert.equal(result.files.length, 1);
  assert.equal(result.totalMatches, 1);
});

test("a hung child is escalated from SIGTERM to SIGKILL", async () => {
  const root = repoWithFile("src/main/java/demo/A.java");
  const dir = mkdtempSync(path.join(tmpdir(), "fake-rg-hung-"));
  const script = path.join(dir, "hung.mjs");
  writeFileSync(script, `
process.on("SIGTERM", () => {});
process.stdout.write(${JSON.stringify(matchLine("src/main/java/demo/A.java"))} + "\\n");
setInterval(() => {}, 1000);
`, "utf8");

  // Generous process-start headroom: this asserts SIGTERM->SIGKILL escalation,
  // not a sub-second Node startup SLA. The child still hangs indefinitely, so
  // the one-second deadline deterministically exercises the same timeout path.
  const runner = fakeRunner(script, { killGraceMs: 100 });
  const result = await runner.run(query(root), DeadlineBudget.fromTimeout(1_000));

  assert.equal(result.completion, "PARTIAL_TIMEOUT");
  assert.equal(result.files.length, 1);
});

test("a noisy child cannot block on a full stderr pipe", async () => {
  const root = repoWithFile("src/main/java/demo/A.java");
  const noise = Array.from({ length: 400 }, () => "__STDERR_warning-line__");
  const script = await writeFakeRgScript([
    ...noise,
    matchLine("src/main/java/demo/A.java")
  ]);
  const runner = fakeRunner(script);
  const result = await runner.run(query(root), DeadlineBudget.fromTimeout(10_000));

  assert.equal(result.completion, "COMPLETE");
  assert.equal(result.totalMatches, 1);
  assert.equal((result.stderrTail ?? "").length <= 8 * 1024, true, "stderr is kept as a bounded tail");
});

test("malformed JSON fails the search instead of silently losing matches", async () => {
  const root = repoWithFile("src/main/java/demo/A.java");
  const script = await writeFakeRgScript([
    matchLine("src/main/java/demo/A.java"),
    "{not valid json",
    matchLine("src/main/java/demo/A.java", 2)
  ]);
  const runner = fakeRunner(script);
  const result = await runner.run(query(root), DeadlineBudget.fromTimeout(10_000));

  assert.equal(result.completion, "FAILED");
  assert.equal(result.errorCode, "SEARCH_FAILED");
});

test("the match cap makes the result PARTIAL_LIMIT", async () => {
  const root = repoWithFile("src/main/java/demo/A.java");
  const script = await writeFakeRgScript(
    Array.from({ length: 20 }, (_, index) => matchLine("src/main/java/demo/A.java", index + 1))
  );
  const runner = fakeRunner(script, { maxMatches: 5 });
  const result = await runner.run(query(root), DeadlineBudget.fromTimeout(10_000));

  assert.equal(result.completion, "PARTIAL_LIMIT");
  assert.equal(result.totalMatches >= 5, true);
});

test("the raw byte cap makes the result PARTIAL_LIMIT", async () => {
  const root = repoWithFile("src/main/java/demo/A.java");
  const script = await writeFakeRgScript(
    Array.from({ length: 50 }, (_, index) => matchLine("src/main/java/demo/A.java", index + 1))
  );
  const runner = fakeRunner(script, { maxRawBytes: 200 });
  const result = await runner.run(query(root), DeadlineBudget.fromTimeout(10_000));

  assert.equal(result.completion, "PARTIAL_LIMIT");
});

test("an oversized single JSON record makes the result PARTIAL_LIMIT", async () => {
  const root = repoWithFile("src/main/java/demo/A.java");
  const script = await writeFakeRgScript([matchLine("src/main/java/demo/A.java")]);
  const runner = fakeRunner(script, { maxLineBytes: 10 });
  const result = await runner.run(query(root), DeadlineBudget.fromTimeout(10_000));

  assert.equal(result.completion, "PARTIAL_LIMIT");
});

test("a pattern beginning with a dash is treated as a pattern, not a flag", async () => {
  const root = repoWithFile("src/main/java/demo/A.java");
  const script = await writeFakeRgScript([matchLine("src/main/java/demo/A.java")]);
  const runner = fakeRunner(script);
  const result = await runner.run(query(root, "--not-a-flag"), DeadlineBudget.fromTimeout(10_000));

  assert.equal(result.completion, "COMPLETE");
  assert.equal(result.totalMatches, 1);
});

test("matches resolving outside the repo root are suppressed", async () => {
  const outside = mkdtempSync(path.join(tmpdir(), "rg-outside-"));
  writeFileSync(path.join(outside, "External.java"), "class External {}\n", "utf8");
  const root = repoWithFile("src/main/java/demo/A.java");
  symlinkSync(outside, path.join(root, "link"), "dir");

  const script = await writeFakeRgScript([
    matchLine("src/main/java/demo/A.java"),
    matchLine("link/External.java"),
    matchLine("../escaped/Other.java")
  ]);
  const runner = fakeRunner(script);
  const result = await runner.run(query(root), DeadlineBudget.fromTimeout(10_000));

  assert.equal(result.completion, "COMPLETE");
  assert.deepEqual(
    result.files.map(file => path.basename(file.absolutePath)),
    ["A.java"],
    "a symlinked-out and a parent-escaping hit are both dropped"
  );
});

test("exit status 1 with no matches is a complete search", async () => {
  const root = repoWithFile("src/main/java/demo/A.java");
  const script = await writeFakeRgScript(["__EXIT_1__"]);
  const runner = fakeRunner(script);
  const result = await runner.run(query(root), DeadlineBudget.fromTimeout(10_000));

  assert.equal(result.completion, "COMPLETE");
  assert.equal(result.totalMatches, 0);
  assert.equal(result.errorCode, undefined);
});

test("a non-zero, non-one exit status is a failure", async () => {
  const root = repoWithFile("src/main/java/demo/A.java");
  const script = await writeFakeRgScript(["__EXIT_2__"]);
  const runner = fakeRunner(script);
  const result = await runner.run(query(root), DeadlineBudget.fromTimeout(10_000));

  assert.equal(result.completion, "FAILED");
  assert.equal(result.errorCode, "SEARCH_FAILED");
});

test("a missing binary is reported as a failed search, not a throw", async () => {
  const root = repoWithFile("src/main/java/demo/A.java");
  const runner = new RgRunner({ binary: path.join(root, "does-not-exist") });
  const result = await runner.run(query(root), DeadlineBudget.fromTimeout(10_000));

  assert.equal(result.completion, "FAILED");
  assert.equal(result.errorCode, "SEARCH_FAILED");
});

test("positions per file are bounded while matchCount keeps counting", async () => {
  const root = repoWithFile("src/main/java/demo/A.java");
  const script = await writeFakeRgScript(
    Array.from({ length: 9 }, (_, index) => matchLine("src/main/java/demo/A.java", index + 1))
  );
  const runner = fakeRunner(script, { maxPositionsPerFile: 2 });
  const result = await runner.run(query(root), DeadlineBudget.fromTimeout(10_000));

  assert.equal(result.completion, "COMPLETE");
  assert.equal(result.files[0].matchCount, 9);
  assert.equal(result.files[0].positions.length, 2);
  assert.deepEqual(result.files[0].positions[0], { line: 1, column: 7 });
});

test("columns are 1-based UTF-16 code units, not rg's byte offsets, after Chinese text and an emoji", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "rg-utf16-"));
  const relative = "src/main/java/demo/Orders.java";
  const line = "    // 订单😀 Target target = new Target();";
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, relative), `package demo;\n${line}\n`, "utf8");
  const result = await new RgRunner().run(query(root, "Target"), DeadlineBudget.fromTimeout(10_000));

  assert.equal(result.completion, "COMPLETE");
  const [position] = result.files[0].positions;
  // The index and java_symbol(file,line,column) use 1-based UTF-16 columns (runtime/source-range.ts).
  assert.deepEqual(position, { line: 2, column: line.indexOf("Target") + 1 });
  assert.equal(line.slice(position.column - 1).startsWith("Target"), true);
});

test("a match without a line number keeps its count but contributes no guessed position", async () => {
  const root = repoWithFile("src/main/java/demo/A.java");
  const noLine = JSON.stringify({
    type: "match",
    data: {
      path: { text: "src/main/java/demo/A.java" },
      lines: { text: "class A {}\n" },
      submatches: [{ start: 6, end: 7, match: { text: "A" } }]
    }
  });
  const base64Line = JSON.stringify({
    type: "match",
    data: {
      path: { text: "src/main/java/demo/A.java" },
      // rg base64-encodes a line that is not valid UTF-8; "é" before the match is two bytes.
      lines: { bytes: Buffer.from("/*é*/ class A {}\n", "utf8").toString("base64") },
      line_number: 3,
      submatches: [{ start: 13, end: 14, match: { text: "A" } }]
    }
  });
  const script = await writeFakeRgScript([noLine, base64Line]);
  const result = await fakeRunner(script).run(query(root), DeadlineBudget.fromTimeout(10_000));

  assert.equal(result.completion, "COMPLETE");
  assert.equal(result.files[0].matchCount, 2);
  assert.deepEqual(result.files[0].positions, [{ line: 3, column: 13 }]);
});
