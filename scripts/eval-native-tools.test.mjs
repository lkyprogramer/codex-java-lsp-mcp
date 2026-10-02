// input:  createAttemptWorkspace / buildToolSet / resolveInCandidate 真实实现
//         + 一次性 fixture（tmp 目录）。
// output: R03 回归锁——双臂原生工具对称、每 attempt 独立 candidate、
//         canonical containment（realpath/relative，非 startsWith）、
//         symlink/前缀兄弟/Windows 分隔符逃逸、写后重建会话后下一跳可见。
// pos:    纯本地 tmp 文件 + rg 二进制（缺失时 rg 用例按 BLOCKED_ENV 跳过）。
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
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
    // repair arms: both get write_file too - still symmetric.
    const controlRepair = buildToolSet("control", "repair", { candidateRoot: createAttemptWorkspace(fixture, "b:control:r1", fixture + "-out") });
    const productRepair = buildToolSet("product", "repair", { candidateRoot: createAttemptWorkspace(fixture, "b:product:r1", fixture + "-out") });
    assert.deepEqual(controlRepair.tools.map(t => t.function.name), ["write_file", ...nativeToolNames()]);
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