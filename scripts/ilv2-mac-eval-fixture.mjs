// MAC-10 test fixture: a two-commit Java repository (a clamp bug and its fix), a jin-commit-tasks/v1
// candidate file for the fix, a frozen-input record and a curated three-task curation file.
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { sha256 } from "./ilv2-mac-contracts.mjs";

const execute = promisify(execFile);
const git = (cwd, ...args) => execute("git", ["-c", "user.email=f@example.invalid", "-c", "user.name=fixture", "-c", "commit.gpgsign=false", ...args], { cwd });

export const BROKEN_CLAMP = `    public static int clamp(int value, int low, int high) {
        if (value < low) {
            return low;
        }
        return value;
    }`;
export const FIXED_CLAMP = `    public static int clamp(int value, int low, int high) {
        if (value < low) {
            return low;
        }
        if (value > high) {
            return high;
        }
        return value;
    }`;
const calc = body => `package demo;

public final class Calc {
    private Calc() {
    }

${body}
}
`;
const FILES = {
  "src/main/java/demo/PriceRule.java": "package demo;\n\npublic interface PriceRule {\n    int apply(int amount);\n}\n",
  "src/main/java/demo/FlatRule.java": "package demo;\n\npublic final class FlatRule implements PriceRule {\n    @Override\n    public int apply(int amount) {\n        return amount - 5;\n    }\n}\n",
  "src/main/java/demo/PercentRule.java": "package demo;\n\npublic final class PercentRule implements PriceRule {\n    @Override\n    public int apply(int amount) {\n        return amount * 9 / 10;\n    }\n}\n",
  "src/main/java/demo/OrderService.java": "package demo;\n\npublic final class OrderService {\n    private final PriceRule rule;\n\n    public OrderService(PriceRule rule) {\n        this.rule = rule;\n    }\n\n    public int total(int amount) {\n        return Calc.clamp(rule.apply(amount), 0, 1000);\n    }\n}\n",
  "src/main/java/demo/OrderController.java": "package demo;\n\npublic final class OrderController {\n    private final OrderService service = new OrderService(new FlatRule());\n\n    public int quote(int amount) {\n        return service.total(amount);\n    }\n}\n",
  "src/main/resources/demo/OrderMapper.xml": "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<mapper namespace=\"demo.OrderMapper\">\n  <select id=\"findTotal\">select total from orders where id = #{id}</select>\n</mapper>\n",
  // Test sources: one unrelated to the repair (kept), one that names the repaired class (hidden by reference).
  "src/test/java/demo/OrderControllerTest.java": "package demo;\n\nfinal class OrderControllerTest {\n    int quote() {\n        return new OrderController().quote(10);\n    }\n}\n",
  "src/testFixtures/java/demo/CalcFixtures.java": "package demo;\n\nfinal class CalcFixtures {\n    static final Class<?> TYPE = Calc.class;\n}\n"
};
// The fix commit's own tests (hidden by the commit): a test of the repaired class and a test resource.
export const MOVED_FIX_TEST = "src/test/resources/demo/bounds/clamp-cases.txt";
export const FIX_TESTS = {
  "src/test/java/demo/CalcTest.java": "package demo;\n\nfinal class CalcTest {\n    boolean upperBound() {\n        return Calc.clamp(20, 0, 10) == 10;\n    }\n}\n",
  "src/test/resources/demo/clamp-cases.txt": "20 0 10 -> 10\n",
  // Deleted again before the frozen head: not in the corpus, so nothing to hide.
  "src/test/resources/demo/clamp-notes.txt": "upper bound pending\n"
};
export const CLAMP_ORACLE = `package demo;

public final class ClampOracle {
    private ClampOracle() {
    }

    public static void main(String[] args) {
        check(Calc.clamp(5, 0, 10) == 5, "inside");
        check(Calc.clamp(-1, 0, 10) == 0, "below");
        check(Calc.clamp(11, 0, 10) == 10, "above");
        System.out.println("ORACLE PASS");
    }

    private static void check(boolean ok, String id) {
        if (!ok) {
            System.out.println("ORACLE FAIL " + id);
            System.exit(1);
        }
    }
}
`;
const verification = { by: "fixture-curator", at: "2026-10-19T00:00:00Z", method: "read the fixture source", notes: "fixture task, verified against the two fixture commits" };

/** Builds the fixture under `root`; returns every path the dataset converter and runners need. */
export async function evalFixture(root, { tasks, moveFixTestTo = MOVED_FIX_TEST } = {}) {
  const repoRoot = path.join(root, "repo");
  await mkdir(repoRoot, { recursive: true });
  await git(repoRoot, "init", "-q", "-b", "main");
  for (const [file, text] of Object.entries({ ...FILES, "src/main/java/demo/Calc.java": calc(BROKEN_CLAMP) })) {
    await mkdir(path.dirname(path.join(repoRoot, file)), { recursive: true });
    await writeFile(path.join(repoRoot, file), text);
  }
  await git(repoRoot, "add", "-A");
  await git(repoRoot, "commit", "-q", "-m", "initial orders");
  const parent = (await git(repoRoot, "rev-parse", "HEAD")).stdout.trim();
  await writeFile(path.join(repoRoot, "src/main/java/demo/Calc.java"), calc(FIXED_CLAMP));
  await writeFile(path.join(repoRoot, "src/main/java/demo/OrderService.java"), FILES["src/main/java/demo/OrderService.java"].replace("0, 1000", "0, 999"));
  for (const [file, text] of Object.entries(FIX_TESTS)) {
    await mkdir(path.dirname(path.join(repoRoot, file)), { recursive: true });
    await writeFile(path.join(repoRoot, file), text);
  }
  await git(repoRoot, "add", "-A");
  await git(repoRoot, "commit", "-q", "-m", "fix clamp above the upper bound and lower the order cap");
  const fix = (await git(repoRoot, "rev-parse", "HEAD")).stdout.trim();
  // A later commit moves the fix's test resource: it is hidden under its name at the frozen head.
  await mkdir(path.join(repoRoot, path.dirname(moveFixTestTo)), { recursive: true });
  await git(repoRoot, "mv", "src/test/resources/demo/clamp-cases.txt", moveFixTestTo);
  await git(repoRoot, "rm", "-q", "src/test/resources/demo/clamp-notes.txt");
  await git(repoRoot, "commit", "-q", "-m", "move the clamp cases, drop the notes");
  const head = (await git(repoRoot, "rev-parse", "HEAD")).stdout.trim();
  const inputManifest = path.join(root, "fixture-input.json");
  const manifestText = `${JSON.stringify({ schema: "ilv2-mac-input/v1", repoRoot, head, files: [] })}\n`;
  await writeFile(inputManifest, manifestText);
  const inputsFile = path.join(root, "inputs.json");
  await writeFile(inputsFile, `${JSON.stringify([{ name: "fixture", repoRoot, head, manifest: inputManifest, manifestSha256: sha256(manifestText), inputFiles: 11 }])}\n`);
  const candidatesFile = path.join(root, "jin-commit-tasks-fixture.json");
  await writeFile(candidatesFile, `${JSON.stringify({ schemaVersion: "jin-commit-tasks/v1", project: "fixture", repo: repoRoot, head, train: [{ commit: fix, parent, timestamp: 1, task: "fix clamp above the upper bound and lower the order cap",
    files: [{ path: "src/main/java/demo/Calc.java", status: "modify", methods: [] }, { path: "src/main/java/demo/OrderService.java", status: "modify", methods: [] },
    ...Object.keys(FIX_TESTS).map(file => ({ path: file, status: "add", methods: [] }))] }], holdout: [] })}\n`);
  const curationDir = path.join(root, "curation");
  await mkdir(path.join(curationDir, "oracles"), { recursive: true });
  await writeFile(path.join(curationDir, "oracles/ClampOracle.java"), CLAMP_ORACLE);
  await writeFile(path.join(curationDir, "oracles/clamp-pre-state.java"), BROKEN_CLAMP);
  const source = { type: "jin-commit-tasks/v1", commit: fix, parent };
  const defaults = [
    { id: "FX-CALLERS", repo: "fixture", kind: "qa", category: "callers", pinnedDev: true, source,
      prompt: "Which classes call the static method `Calc.clamp`? List their fully qualified names.", anchors: ["Calc", "Calc.clamp"],
      answer: { slots: { callers: { type: "string-set" } }, value: { callers: ["demo.OrderService"] } },
      evidence: [{ path: "src/main/java/demo/OrderService.java", startLine: 10, endLine: 12, why: "total() is the only call site of clamp", fromCommitFiles: true }], verification },
    { id: "FX-IMPLS", repo: "fixture", kind: "qa", category: "implementations", source,
      prompt: "Which concrete classes implement the interface `PriceRule`? List their fully qualified names.", anchors: ["PriceRule"],
      answer: { slots: { implementations: { type: "string-set" } }, value: { implementations: ["demo.FlatRule", "demo.PercentRule"] } },
      evidence: [{ path: "src/main/java/demo/FlatRule.java", startLine: 3, endLine: 8, why: "FlatRule implements PriceRule" },
        { path: "src/main/java/demo/PercentRule.java", startLine: 3, endLine: 8, why: "PercentRule implements PriceRule" }], verification },
    { id: "FX-REPAIR", repo: "fixture", kind: "repair", category: "repair", pinnedDev: true, source,
      prompt: "Clamping a value that lies above the upper bound returns the value unchanged; it must return the upper bound instead.", anchors: [],
      evidence: [{ path: "src/main/java/demo/Calc.java", startLine: 7, endLine: 12, why: "the clamp method body that lacks the upper-bound check", fromCommitFiles: true }],
      repair: { file: "src/main/java/demo/Calc.java", startLine: 7, endLine: 15, preState: "oracles/clamp-pre-state.java", oracle: "oracles/ClampOracle.java",
        mainClass: "demo.ClampOracle", release: 17, timeoutMs: 20000 }, verification }
  ];
  const curationFile = path.join(curationDir, "curation.json");
  await writeFile(curationFile, `${JSON.stringify({ schema: "ilv2-mac10-curation/v1", datasetId: "fixture-v1", holdout: { ratio: 0.3, seed: "fixture" }, tasks: tasks ?? defaults }, null, 2)}\n`);
  return { root, repoRoot, head, fix, parent, inputsFile, candidatesFile, curationFile, curationDir, defaults };
}

/** The frozen JDK of the toolchain manifest every broker run exports. */
export async function frozenJavaHome() {
  const file = process.env.ILV2_TOOLCHAINS;
  if (!file) throw new Error("ILV2_TOOLCHAINS is required: the oracle depends on the frozen JDK only");
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(file, "utf8")).javaHome;
}

/** Test cleanup: a product run seals its snapshots 0555, so write access is restored before removal. */
export async function removeTree(root) {
  const { rm } = await import("node:fs/promises");
  await execute("/bin/chmod", ["-R", "u+w", root]).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
