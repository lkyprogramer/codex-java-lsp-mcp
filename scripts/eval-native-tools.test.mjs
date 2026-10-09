// input:  createAttemptWorkspace / buildToolSet / resolveInCandidate 真实实现
//         + 一次性 fixture（tmp 目录）。
// output: R03 回归锁——双臂原生工具对称、每 attempt 独立 candidate、
//         canonical containment（realpath/relative，非 startsWith）、
//         symlink/前缀兄弟/Windows 分隔符逃逸、写后重建会话后下一跳可见。
// pos:    纯本地 tmp 文件 + rg 二进制（缺失时 rg 用例按 BLOCKED_ENV 跳过）。
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  buildToolSet,
  createAttemptWorkspace,
  resolveInCandidate,
  nativeToolNames,
  RGP_BIN
} from "./eval-native-tools.mjs";
import {
  EVAL_SYSTEM_PROMPT,
  nativeNames
} from "./evaluate-java-task.mjs";

// Fixture: a small repo plus an "outside" file and a PREFIX-SIBLING directory
// that a startsWith check on the workspace path would wrongly admit.
function makeFixture() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "eval-native-"));
  const fixture = path.join(tmp, "fixture");
  mkdirSync(path.join(fixture, "src"), { recursive: true });
  writeFileSync(path.join(fixture, "src", "A.java"), "class A {\n  int alpha() { return 7; }\n  int beta() { return 8; }\n}\n");
  writeFileSync(path.join(fixture, "README.md"), "# fixture\n");
  const outside = path.join(tmp, "outside.txt");
  writeFileSync(outside, "OUTSIDE-SECRET\n");
  // Prefix sibling: tmp/fixture-evil shares the prefix of tmp/fixture.
  const evil = path.join(tmp, "fixture-evil");
  mkdirSync(evil, { recursive: true });
  writeFileSync(path.join(evil, "leak.txt"), "EVIL-LEAK\n");
  // Symlink inside the fixture pointing outside.
  symlinkSync(outside, path.join(fixture, "src", "escape-link.txt"));
  return { tmp, fixture, outside, evil };
}

test("symmetric arms: native names are identical; only java_symbol differs", () => {
  const { fixture } = makeFixture();
  try {
    const controlQa = buildToolSet("control", "qa", { candidateRoot: createAttemptWorkspace(fixture, "a:control:r1", fixture + "-out") });
    const productQa = buildToolSet("product", "qa", { candidateRoot: createAttemptWorkspace(fixture, "a:product:r1", fixture + "-out") });
    assert.deepEqual(nativeNames("control"), nativeNames("product"));
    assert.deepEqual(nativeNames("product"), nativeToolNames());
    assert.deepEqual(controlQa.tools.map(t => t.function.name), nativeToolNames());
    assert.deepEqual(productQa.tools.map(t => t.function.name), nativeToolNames());
    // repair arms: both get write_file and the compile-check test tool - still symmetric.
    const controlRepair = buildToolSet("control", "repair", { candidateRoot: createAttemptWorkspace(fixture, "b:control:r1", fixture + "-out") });
    const productRepair = buildToolSet("product", "repair", { candidateRoot: createAttemptWorkspace(fixture, "b:product:r1", fixture + "-out") });
    assert.deepEqual(controlRepair.tools.map(t => t.function.name), ["write_file", "test", ...nativeToolNames()]);
    assert.deepEqual(productRepair.tools.map(t => t.function.name), controlRepair.tools.map(t => t.function.name));
    // The evaluate host exposes the same native set to both arms; product adds
    // exactly one tool: java_symbol.
    // The prompt no longer restricts any arm to a single unavailable tool and
    // states the shared surface.
    assert.ok(!EVAL_SYSTEM_PROMPT.includes("java_impact tool only"));
    assert.ok(EVAL_SYSTEM_PROMPT.includes("both arms share the native list, rg and read tools"));
  } finally {
    rmSync(fixture + "-out", { recursive: true, force: true });
  }
});

test("per-attempt workspaces: distinct roots, isolated copies", () => {
  const { fixture } = makeFixture();
  const out = fixture + "-ws";
  const a1 = createAttemptWorkspace(fixture, "t:control:r1", out);
  const a2 = createAttemptWorkspace(fixture, "t:product:r1", out);
  try {
    assert.notEqual(a1, a2);
    assert.ok(a1.includes("candidates"));
    // copies are real (not the fixture itself)
    assert.notEqual(path.resolve(a1), path.resolve(fixture));
    writeFileSync(path.join(a1, "src", "A.java"), "class A { /* modified */ }\n");
    const pristine = readText(path.join(a2, "src", "A.java"));
    assert.ok(!pristine.includes("modified"), "attempts must not share files");
    assert.ok(!readText(path.join(fixture, "src", "A.java")).includes("modified"), "fixture must stay pristine");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

function readText(file) {
  return readFileSync(file, "utf8");
}

test("canonical containment: traversal, prefix-sibling, symlink, windows separators", async () => {
  const { fixture, outside, evil } = makeFixture();
  const out = fixture + "-c";
  const root = createAttemptWorkspace(fixture, "contain", out);
  const set = buildToolSet("control", "qa", { candidateRoot: root });
  try {
    // baseline read works
    const ok = await set.invoke("read", { path: "src/A.java" });
    assert.ok(ok.text.includes("alpha"));
    // ../ traversal: the outside file sits at tmp/outside.txt while the
    // workspace is tmp/.../candidates/contain - ../.. would need multiple hops;
    // a direct ../outside.txt must be rejected by relative containment.
    const esc = await set.invoke("read", { path: "../outside.txt" });
    assert.ok(typeof esc.error === "string", "traversal must be rejected");
    const esc2 = await set.invoke("read", { path: "../../outside.txt" });
    assert.ok(typeof esc2.error === "string");
    // absolute path is never a repo-relative path
    const abs = await set.invoke("read", { path: outside });
    assert.ok(typeof abs.error === "string");
    // prefix-sibling directory is a DIFFERENT resolved root: a startsWith on
    // the string prefix would admit it; realpath/relative must not.
    const evilRel = path.relative(root, evil);
    const evilProbe = await set.invoke("read", { path: evilRel });
    assert.ok(typeof evilProbe.error === "string", "prefix-sibling must be rejected");
    assert.ok(!evilProbe.text?.includes("EVIL-LEAK"));
    // symlink inside the workspace pointing outside: realpath escape.
    const link = await set.invoke("read", { path: "src/escape-link.txt" });
    assert.ok(typeof link.error === "string", "symlink escape must be rejected");
    assert.ok(!link.text?.includes("OUTSIDE-SECRET"));
    // Windows separators normalize to the same containment semantics.
    const win = await set.invoke("read", { path: "src\\A.java" });
    assert.ok(win.text.includes("alpha"), "backslash paths normalize");
    const winEsc = await set.invoke("read", { path: "..\\outside.txt" });
    assert.ok(typeof winEsc.error === "string");
    // missing file returns a structured error, not a throw
    const missing = await set.invoke("read", { path: "src/Nope.java" });
    assert.ok(typeof missing.error === "string");
    assert.ok(missing.error.includes("read failed"));
    // list + rg on the candidate root
    const list = await set.invoke("list", { path: "src" });
    assert.ok(list.entries.includes("A.java"));
    const rg = await runRg(set, "alpha");
    if (rg.blockedEnv) {
      // rg missing on this host: mechanism stays testable via the error shape
      assert.ok(rg.result.error.includes("BLOCKED_ENV"));
    } else {
      assert.ok(rg.result.output.includes("A.java:2:  int alpha()"));
    }
    // resolveInCandidate is exported for the judge/adapter layer
    assert.ok(resolveInCandidate(root, "../outside.txt").error);
    assert.ok(!resolveInCandidate(root, "src/A.java").error);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

async function runRg(set, pattern) {
  const result = await set.invoke("rg", { pattern });
  return { result, blockedEnv: typeof result?.error === "string" && result.error.includes("BLOCKED_ENV") };
}

test("write (repair kind) is confined to the candidate and re-readable", async () => {
  const { fixture } = makeFixture();
  const out = fixture + "-w";
  const root = createAttemptWorkspace(fixture, "write:qa-vs-repair", out);
  try {
    const qa = buildToolSet("product", "qa", { candidateRoot: root });
    const qaWrite = await qa.invoke("write_file", { path: "src/A.java", content: "x" });
    assert.ok(typeof qaWrite.error === "string", "qa kind must not expose write_file");
    const repair = buildToolSet("product", "repair", { candidateRoot: root });
    const written = await repair.invoke("write_file", { path: "src/A.java", content: "class A { int fixed() { return 1; } }\n" });
    assert.equal(written.written, true);
    assert.ok(readText(path.join(root, "src", "A.java")).includes("fixed"));
    // escape write is rejected
    const bad = await repair.invoke("write_file", { path: "../../outside.txt", content: "x" });
    assert.ok(typeof bad.error === "string");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("after a write, a rebound session observes the modification on the next query", async () => {
  // Mechanism-level proxy for the live-loop rebind: invoke write through the
  // repair toolset, then a fresh read from the SAME candidate root must see
  // the new bytes - exactly the property the live loop's session rebind gives
  // to java_symbol's next query.
  const { fixture } = makeFixture();
  const out = fixture + "-rebind";
  const root = createAttemptWorkspace(fixture, "rebind:r1", out);
  try {
    const set = buildToolSet("product", "repair", { candidateRoot: root });
    const before = await set.invoke("read", { path: "src/A.java" });
    assert.ok(before.text.includes("alpha"));
    const written = await set.invoke("write_file", { path: "src/A.java", content: "class A { int alpha() { return 42; } }\n" });
    assert.equal(written.written, true);
    const after = await set.invoke("read", { path: "src/A.java" });
    assert.ok(after.text.includes("42"), "the next read on the same root must observe the modification");
    assert.ok(!after.text.includes("return 7"));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
test("R03 isolation: symlinked directory cannot carry a NEW-file write outside the workspace", async () => {
  const { tmp, fixture } = makeFixture();
  const outsideDir = path.join(tmp, "outside-dir");
  mkdirSync(outsideDir);
  const out = fixture + "-symdir";
  const root = createAttemptWorkspace(fixture, "symdir", out);
  try {
    symlinkSync(outsideDir, path.join(root, "linked"));
    const repair = buildToolSet("product", "repair", { candidateRoot: root });
    const res = await repair.invoke("write_file", { path: "linked/Evil.java", content: "class Evil {}\n" });
    assert.ok(typeof res.error === "string", "write through a symlinked directory must be rejected");
    assert.equal(existsSync(path.join(outsideDir, "Evil.java")), false);
    const deep = await repair.invoke("write_file", { path: "linked/a/b/Evil.java", content: "x" });
    assert.ok(typeof deep.error === "string");
    assert.equal(existsSync(path.join(outsideDir, "a")), false);
    // a brand-new nested file inside the workspace is still fine
    const ok = await repair.invoke("write_file", { path: "src/new/B.java", content: "class B {}\n" });
    assert.equal(ok.written, true);
    // a name that merely starts with ".." is not a traversal
    assert.ok(!resolveInCandidate(root, "..notparent.txt").error);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("R03 isolation: workspaces never merge, keys never collide, .git dirs only are skipped", () => {
  const { fixture } = makeFixture();
  mkdirSync(path.join(fixture, ".git"), { recursive: true });
  writeFileSync(path.join(fixture, ".git", "HEAD"), "ref: x\n");
  writeFileSync(path.join(fixture, ".gitignore"), "target/\n");
  mkdirSync(path.join(fixture, ".github"), { recursive: true });
  writeFileSync(path.join(fixture, ".github", "ci.yml"), "on: push\n");
  const out = fixture + "-iso";
  try {
    const a = createAttemptWorkspace(fixture, "t:a/b:r1", out);
    const b = createAttemptWorkspace(fixture, "t:a_b:r1", out);
    assert.notEqual(a, b, "keys that sanitize identically still get distinct roots");
    assert.throws(() => createAttemptWorkspace(fixture, "t:a/b:r1", out), /already exists/, "a re-run must not merge into an old candidate");
    assert.equal(existsSync(path.join(a, ".git")), false);
    assert.equal(existsSync(path.join(a, ".gitignore")), true);
    assert.equal(existsSync(path.join(a, ".github", "ci.yml")), true);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("R01/R03 read: exact line bytes (CRLF kept), no phantom line, file hash, byte cap by whole lines", async () => {
  const { fixture } = makeFixture();
  writeFileSync(path.join(fixture, "src", "C.java"), "class C {\r\n  int a;\r\n}\r\n");
  writeFileSync(path.join(fixture, "src", "Big.java"), Array.from({ length: 300 }, (_, i) => `// line ${i + 1} ${"x".repeat(90)}\n`).join(""));
  writeFileSync(path.join(fixture, "src", "Wide.java"), `${"y".repeat(20_000)}\n`);
  const out = fixture + "-read";
  const root = createAttemptWorkspace(fixture, "read", out);
  try {
    const set = buildToolSet("control", "qa", { candidateRoot: root });
    const crlf = await set.invoke("read", { path: "src/C.java" });
    assert.equal(crlf.text, "class C {\r\n  int a;\r\n}\r\n");
    assert.equal(crlf.endLine, 3, "trailing CRLF is not a phantom 4th line");
    assert.equal(crlf.contentHash, createHash("sha256").update(readFileSync(path.join(root, "src", "C.java"))).digest("hex"));
    const big = await set.invoke("read", { path: "src/Big.java", maxLines: 300 });
    assert.ok(Buffer.byteLength(big.text, "utf8") <= 16_000);
    assert.equal(big.truncated, true);
    assert.equal(big.nextStartLine, big.endLine + 1);
    assert.ok(big.text.endsWith("\n"), "cut on a whole line");
    const wide = await set.invoke("read", { path: "src/Wide.java" });
    assert.ok(typeof wide.error === "string", "a single line over the cap is an explicit error, never a partial line");
    const bad = await set.invoke("read", { path: "src/C.java", startLine: "abc" });
    assert.ok(typeof bad.error === "string");
    const past = await set.invoke("read", { path: "src/C.java", startLine: 10 });
    assert.equal(past.text, "");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("R03 rg: maxResults caps the TOTAL lines and truncation is flagged", async () => {
  const { fixture } = makeFixture();
  for (let i = 0; i < 5; i += 1) writeFileSync(path.join(fixture, "src", `R${i}.java`), "needle\nneedle\n");
  const out = fixture + "-rg";
  const root = createAttemptWorkspace(fixture, "rg", out);
  try {
    const set = buildToolSet("control", "qa", { candidateRoot: root });
    const res = await set.invoke("rg", { pattern: "needle", maxResults: 3 });
    if (typeof res.error === "string" && res.error.includes("BLOCKED_ENV")) return;
    assert.equal(res.matches, 3);
    assert.equal(res.truncated, true);
    assert.equal(res.output.trim().split("\n").length, 3);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("R03 test tool: compile check reports diagnostics and never touches the candidate tree", async t => {
  try {
    execFileSync(process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", "javac") : "javac", ["-version"], { stdio: "ignore" });
  } catch {
    t.skip("javac unavailable (BLOCKED_ENV)");
    return;
  }
  const { fixture } = makeFixture();
  rmSync(path.join(fixture, "src", "escape-link.txt"));
  const out = fixture + "-test";
  const root = createAttemptWorkspace(fixture, "compile", out);
  try {
    const set = buildToolSet("control", "repair", { candidateRoot: root });
    const listing = () => execFileSync("find", [root], { encoding: "utf8" }).split("\n").sort().join("\n");
    const before = listing();
    const ok = await set.invoke("test", {});
    assert.equal(ok.status, "COMPILED", ok.output);
    assert.equal(listing(), before, "no class files or scratch output inside the candidate");
    await set.invoke("write_file", { path: "src/A.java", content: "class A { int broken( }\n" });
    const fail = await set.invoke("test", {});
    assert.equal(fail.status, "COMPILE_FAILED");
    assert.ok(fail.output.includes("A.java"));
    assert.ok(!fail.output.includes(root), "absolute candidate paths are not leaked");
    const qa = buildToolSet("control", "qa", { candidateRoot: root });
    assert.ok(typeof (await qa.invoke("test", {})).error === "string", "qa kind has no test tool");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
