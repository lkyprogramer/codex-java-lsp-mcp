// input:  candidate repo（agent 运行后的拷贝）+ 原始 fixture repo + 冻结 repair
//         manifest 条目（allowed_edits/test_file/test_class/java_release/timeout）。
// output: 判定报告 {passed, status, detail, policy, judgeWorkspace, compile, run}。
//         策略与进程边界复用 scripts/eval-repair-adapter.mjs 的同一实现；
//         validated_success 的权威来源仍是原 Python frozen judge
//         （scripts/eval-repair-adapter.mjs -> python -m harness repair）。
// pos:    R04：本文件是无 Python 时的离线兜底判定器，与冻结判定器同一策略口径：
//         allowed 源码被候选删除 = REJECTED_MISSING_ALLOWED_FILE（绝不恢复原
//         文件假装候选）；额外/越权文件与 symlink 一律核查；编译器缺失或
//         --release 不支持 = BLOCKED_ENV，不是业务 RED；子进程有 128KiB 输出
//         上限、绝对 timeout 和进程树清理；完成回执带 nonce，内容必须匹配。
//         回执仍是完成性检查，不是同权限恶意代码的操作系统沙箱。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  MAX_OUTPUT_BYTES,
  REPAIR_STATE,
  diffCandidateTrees,
  runBounded,
  probeJavaToolchain,
  stageCandidateTree,
  walkTree
} from "../../scripts/eval-repair-adapter.mjs";

export { REPAIR_STATE };

/**
 * 判断器主流程。workDir 由调用方放在 repo 外的隔离运行目录。
 */
export async function judgeRepair({ task, manifestEntry, fixtureRoot, candidateRoot, workDir, javaHome, testSourceFile }) {
  const report = {
    task: task.id,
    schema: "frozen-repair-judge/v2",
    testClass: manifestEntry.test_class,
    javaRelease: manifestEntry.java_release,
    timeoutSeconds: manifestEntry.timeout_seconds,
    maxOutputBytes: MAX_OUTPUT_BYTES
  };
  const reject = (status, detail) => {
    report.passed = false;
    report.status = status;
    report.detail = detail;
    return report;
  };

  // 1) 候选策略：全文件 hash 对比 + 删除/越权/symlink 检查（与冻结判定器同一实现）。
  const policy = diffCandidateTrees({ fixtureRoot, candidateRoot, allowedEdits: manifestEntry.allowed_edits });
  report.policy = policy;
  if (policy.symlinks.length > 0) {
    return reject(REPAIR_STATE.REJECTED_UNSAFE_PATH, `non-regular entries in the trees: ${policy.symlinks.join(", ")}`);
  }
  if (policy.missingAllowed.length > 0) {
    return reject(
      REPAIR_STATE.REJECTED_MISSING_ALLOWED_FILE,
      `candidate deleted allowed source file(s): ${policy.missingAllowed.join(", ")}; the judge never restores the pristine copy`
    );
  }
  if (policy.violations.length > 0) {
    return reject(REPAIR_STATE.REJECTED_DISALLOWED_EDIT, `files outside allowed_edits: ${policy.violations.join(", ")}`);
  }

  // 2) 编译器缺失或 --release 不支持 = BLOCKED_ENV，不能冒充业务 RED/COMPILE_FAILED。
  const toolchain = await probeJavaToolchain({ javaHome, release: manifestEntry.java_release });
  report.toolchain = toolchain;
  if (!toolchain.available) return reject(REPAIR_STATE.BLOCKED_ENV, toolchain.reason);

  // 3) 干净原工程 + 仅覆盖允许源码（候选删除的文件在这里同样被删除）+
  //    注入 evaluator-owned 冻结测试到 judge 目录。
  const judgeRepo = path.join(workDir, "judge-repo");
  const staged = stageCandidateTree({
    fixtureRoot,
    candidateRoot,
    allowedEdits: manifestEntry.allowed_edits,
    dest: judgeRepo
  });
  report.judgeWorkspace = { path: staged.dest, applied: staged.applied, deleted: staged.deleted, files: staged.files };

  const testClass = manifestEntry.test_class; // e.g. lab.ledger.FrozenLedgerTest
  const parts = testClass.split(".");
  const className = parts.pop();
  const testDir = path.join(judgeRepo, "judge", ...parts);
  mkdirSync(testDir, { recursive: true });
  writeFileSync(path.join(testDir, `${className}.java`), readFileSync(testSourceFile, "utf8"), "utf8");
  // 外部 FrozenJudgeRunner：反射调用冻结测试 main，正常返回后才写带 nonce 的完成回执。
  writeFileSync(
    path.join(judgeRepo, "judge", "FrozenJudgeRunner.java"),
    `public class FrozenJudgeRunner {
  public static void main(String[] a) throws Exception {
    Class.forName("${testClass}").getMethod("main", String[].class).invoke(null, (Object) new String[]{});
    java.nio.file.Files.write(java.nio.file.Paths.get(a[0]), a[1].getBytes("UTF-8"));
  }
}
`,
    "utf8"
  );

  // 4) 编译：产品源码 + 冻结测试；-proc:none 禁注解处理；--release 需要 JDK9+。
  const sourceFiles = [];
  for (const root of manifestEntry.source_roots) {
    for (const rel of walkTree(path.join(judgeRepo, root)).keys()) {
      if (rel.endsWith(".java")) sourceFiles.push(path.join(judgeRepo, root, ...rel.split("/")));
    }
  }
  sourceFiles.push(path.join(testDir, `${className}.java`));
  sourceFiles.push(path.join(judgeRepo, "judge", "FrozenJudgeRunner.java"));
  const classes = path.join(workDir, "classes");
  mkdirSync(classes, { recursive: true });
  const javac = await runBounded(
    [toolchain.javac, "-proc:none", "-encoding", "UTF-8", "-d", classes, "--release", String(manifestEntry.java_release), ...sourceFiles],
    { cwd: workDir, timeoutMs: 60_000, maxBytes: MAX_OUTPUT_BYTES }
  );
  report.compile = {
    exit_code: javac.exitCode,
    timeout: javac.timedOut,
    output_limit: javac.outputLimit,
    stdout: javac.stdout.slice(0, 2000),
    stderr: javac.stderr.slice(0, 2000)
  };
  if (javac.timedOut) return reject(REPAIR_STATE.TIMEOUT, `javac exceeded its timeout; process tree killed`);
  if (javac.outputLimit) return reject(REPAIR_STATE.OUTPUT_LIMIT, `javac exceeded ${MAX_OUTPUT_BYTES} bytes of output; process tree killed`);
  if (javac.exitCode !== 0) {
    const text = `${javac.stderr}\n${javac.stdout}`;
    if (/release version .*not supported|invalid source release|invalid target release/i.test(text)) {
      return reject(REPAIR_STATE.BLOCKED_ENV, `toolchain cannot compile --release ${manifestEntry.java_release}: ${text.slice(0, 400)}`);
    }
    return reject(REPAIR_STATE.COMPILE_FAILED, text.slice(0, 600));
  }

  // 5) 执行 FrozenJudgeRunner（反射调冻结测试）；回执缺失或 nonce 不匹配 = 失败，
  //    即使 JVM 退出码 0。
  const receipt = path.join(workDir, "receipt.txt");
  const nonce = `${task.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  const test = await runBounded(
    [javaHome ? path.join(javaHome, "bin", "java") : "java", "-Xmx128m", "-cp", classes, "FrozenJudgeRunner", receipt, nonce],
    { cwd: workDir, timeoutMs: manifestEntry.timeout_seconds * 1000, maxBytes: MAX_OUTPUT_BYTES }
  );
  report.run = {
    exit_code: test.exitCode,
    timeout: test.timedOut,
    output_limit: test.outputLimit,
    stdout: test.stdout.slice(0, 2000),
    stderr: test.stderr.slice(0, 2000)
  };
  const completed = existsSync(receipt) && readFileSync(receipt, "utf8") === nonce;
  report.frozenTestCompleted = completed;
  if (test.timedOut) return reject(REPAIR_STATE.TIMEOUT, "frozen test exceeded its timeout; the process tree was killed");
  if (test.outputLimit) return reject(REPAIR_STATE.OUTPUT_LIMIT, `frozen test exceeded ${MAX_OUTPUT_BYTES} bytes of output; the process tree was killed`);
  if (test.exitCode !== 0) {
    return reject(REPAIR_STATE.TEST_FAILED, (test.stderr || test.stdout).slice(0, 600));
  }
  if (!completed) {
    return reject(REPAIR_STATE.MISSING_RECEIPT, "JVM exited 0 but the nonce receipt is absent or mismatched");
  }
  report.passed = true;
  report.status = "PASS";
  return report;
}
