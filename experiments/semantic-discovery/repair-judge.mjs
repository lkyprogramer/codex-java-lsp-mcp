// input:  candidate repo（agent 运行后的拷贝）+ 原始 fixture repo + 冻结 repair
//         manifest 条目（allowed_edits/test_file/test_class/java_release/timeout）。
// output: docs/07 判断器协议：candidate 与原始 fixture 全文件 hash 对比，非
//         allowed_edits 变动即拒绝；干净原工程 + 仅覆盖允许源码 + 注入
//         evaluator-owned 冻结测试到外部 judge 目录；javac -proc:none 编译、
//         java -Xmx128m 执行；测试 main 抛 AssertionError = 业务失败；回执
//         文件是完成性检查（缺失即失败），不是安全沙箱。
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

function walkFiles(root) {
  const out = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(root);
  return out;
}

function fileHash(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function snapshot(root) {
  const map = new Map();
  for (const file of walkFiles(root)) {
    map.set(path.relative(root, file).split(path.sep).join("/"), fileHash(file));
  }
  return map;
}

/**
 * 判断器主流程。receiptPath 由调用方放在 repo 外的 judge 回执目录。
 * 返回 {passed, status, detail, diffReport}。
 */
export async function judgeRepair({ task, manifestEntry, fixtureRoot, candidateRoot, workDir, javaHome, testSourceFile }) {
  const report = {
    task: task.id,
    schema: "frozen-repair-judge/v1",
    testClass: manifestEntry.test_class,
    javaRelease: manifestEntry.java_release,
    timeoutSeconds: manifestEntry.timeout_seconds
  };

  // 1) 全文件 hash 对比：非 allowed_edits 变动直接拒绝。
  const before = snapshot(fixtureRoot);
  const after = snapshot(candidateRoot);
  const changed = [];
  const removed = [];
  for (const [rel, hash] of before) {
    if (!after.has(rel)) removed.push(rel);
    else if (after.get(rel) !== hash) changed.push(rel);
  }
  for (const rel of after.keys()) {
    if (!before.has(rel)) changed.push(`+${rel}`);
  }
  const allowed = new Set(manifestEntry.allowed_edits);
  const violations = [...removed, ...changed.filter(c => !c.startsWith("+")).map(c => c), ...changed.filter(c => c.startsWith("+"))]
    .filter(rel => !allowed.has(rel) && !allowed.has(rel.replace(/^\+/, "")));
  report.diffReport = { changed, removed };
  if (violations.length > 0) {
    report.passed = false;
    report.status = "REJECTED_UNALLOWED_EDIT";
    report.detail = `files outside allowed_edits: ${violations.join(", ")}`;
    return report;
  }

  // 2) 干净原工程 + 仅覆盖允许源码 + 注入冻结测试到外部 judge 目录。
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  const judgeRepo = path.join(workDir, "judge-repo");
  cpSync(fixtureRoot, judgeRepo, { recursive: true });
  for (const rel of manifestEntry.allowed_edits) {
    const src = path.join(candidateRoot, ...rel.split("/"));
    const dst = path.join(judgeRepo, ...rel.split("/"));
    if (existsSync(src)) cpSync(src, dst);
  }
  const testClass = manifestEntry.test_class; // e.g. lab.ledger.FrozenLedgerTest
  const parts = testClass.split(".");
  const className = parts.pop();
  const testDir = path.join(judgeRepo, "judge", ...parts);
  mkdirSync(testDir, { recursive: true });
  writeFileSync(path.join(testDir, `${className}.java`), readFileSync(testSourceFile, "utf8"), "utf8");
  // 外部 FrozenJudgeRunner：反射调用冻结测试 main，正常返回后才写完成回执。
  // 回执是完成性检查，不是同权限恶意代码的安全沙箱（docs/07）。
  writeFileSync(
    path.join(judgeRepo, "judge", "FrozenJudgeRunner.java"),
    `public class FrozenJudgeRunner {
  public static void main(String[] a) throws Exception {
    Class.forName("${testClass}").getMethod("main", String[].class).invoke(null, (Object) new String[]{});
    java.nio.file.Files.write(java.nio.file.Paths.get(a[0]), "OK".getBytes("UTF-8"));
  }
}
`,
    "utf8"
  );

  // 3) 编译：产品源码 + 冻结测试；-proc:none 禁注解处理。release 用 --release
  // 双横线形态（对 JDK 9+ 与旧 javac 都成立），兼容本机 javac 25。
  const sourceFiles = [];
  for (const root of manifestEntry.source_roots) {
    for (const file of walkFiles(path.join(judgeRepo, root))) {
      if (file.endsWith(".java")) sourceFiles.push(file);
    }
  }
  sourceFiles.push(path.join(testDir, `${className}.java`));
  sourceFiles.push(path.join(judgeRepo, "judge", "FrozenJudgeRunner.java"));
  const classes = path.join(workDir, "classes");
  mkdirSync(classes, { recursive: true });
  const javacArgs = ["-proc:none", "-d", classes, "--release", String(manifestEntry.java_release), ...sourceFiles];
  const javac = await runJava(javacArgs, { javaHome, timeoutMs: 60_000, tool: "javac" });
  if (javac.exitCode !== 0) {
    report.passed = false;
    report.status = "COMPILE_FAILED";
    report.detail = (javac.stderr || javac.stdout).slice(0, 600);
    return report;
  }

  // 4) 执行 FrozenJudgeRunner（反射调冻结测试）；回执缺失 = 失败（即使 JVM 退出码 0）。
  const receipt = path.join(workDir, "receipt.txt");
  const testArgs = ["-Xmx128m", "-cp", classes, "FrozenJudgeRunner", receipt];
  const test = await runJava(testArgs, { javaHome, timeoutMs: manifestEntry.timeout_seconds * 1000 });
  report.exitCode = test.exitCode;
  if (test.exitCode !== 0) {
    report.passed = false;
    report.status = /timed out/i.test(test.stderr || "") ? "TIMEOUT" : "TEST_FAILED";
    report.detail = (test.stderr || test.stdout).slice(0, 600);
    return report;
  }
  if (!existsSync(receipt)) {
    report.passed = false;
    report.status = "MISSING_RECEIPT";
    report.detail = "JVM exited 0 but the completion receipt is absent";
    return report;
  }
  report.passed = true;
  report.status = "PASS";
  return report;
}

async function runJava(args, { javaHome, timeoutMs, tool = "java" }) {
  const bin = javaHome ? path.join(javaHome, "bin", tool) : tool;
  return new Promise(resolve => {
    let settled = false;
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        resolve({ exitCode: -1, stdout, stderr: `${stderr}\n[timed out after ${timeoutMs}ms]` });
      }
    }, timeoutMs);
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    child.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
    child.on("error", err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: String(err.message ?? err) });
    });
  });
}