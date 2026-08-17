import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  V4_SPRINT0_IDENTITY_COMMIT,
  V4_SPRINT0_PRODUCTION_TREE
} from "./verify-v4-sprint0-baseline.mjs";
import {
  buildSprint0CommandPlan,
  defaultRepoCandidates,
  descriptorForBytes,
  parseSprint0Cli,
  planV4Sprint0Baseline,
  resolveSprint0Repositories
} from "./run-v4-sprint0-baseline.mjs";

const FROZEN = {
  lishuedu: "db63b1a7e393edd90449eb013d7d1c4d65c366f2",
  cipherlink: "fa433982e92e52dd610650d1e79f2d041179b1d3",
  "exam-parent-v3": "f90a0b475f7be2ed003703feecec8195bc7eb976"
};

test("Sprint0' CLI prefers flags, then env, and keeps the merge SHA as default baseline", () => {
  const cli = parseSprint0Cli(
    ["--dry-run", "--stage", "bytes", "--lishuedu", "/tmp/l", "--output-dir", "/tmp/out"],
    { CIPHERLINK_ROOT: "/tmp/c", EXAM_PARENT_V3_ROOT: "/tmp/e" }
  );
  assert.equal(cli.dryRun, true);
  assert.equal(cli.stage, "bytes");
  assert.equal(cli.baseline, V4_SPRINT0_IDENTITY_COMMIT);
  assert.equal(cli.repositories.lishuedu, "/tmp/l");
  assert.equal(cli.repositories.cipherlink, "/tmp/c");
});

test("repository resolver only accepts the progressive-lock frozen commits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "v4-sprint0-repos-"));
  const heads = {
    [path.join(root, "lishuedu")]: FROZEN.lishuedu,
    [path.join(root, "cipherlink")]: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    [path.join(root, "exam-parent-v3")]: FROZEN["exam-parent-v3"]
  };
  for (const repoRoot of Object.keys(heads)) await mkdir(repoRoot, { recursive: true });
  await assert.rejects(
    () => resolveSprint0Repositories({
      repositories: {
        lishuedu: path.join(root, "lishuedu"),
        cipherlink: path.join(root, "cipherlink"),
        "exam-parent-v3": path.join(root, "exam-parent-v3")
      },
      candidates: { lishuedu: [], cipherlink: [], "exam-parent-v3": [] },
      expectedCommits: FROZEN,
      git: async repoRoot => heads[repoRoot]
    }),
    /cipherlink: no frozen checkout/
  );

  heads[path.join(root, "cipherlink")] = FROZEN.cipherlink;
  const resolved = await resolveSprint0Repositories({
    repositories: {
      lishuedu: path.join(root, "lishuedu"),
      cipherlink: path.join(root, "cipherlink"),
      "exam-parent-v3": path.join(root, "exam-parent-v3")
    },
    candidates: { lishuedu: [], cipherlink: [], "exam-parent-v3": [] },
    expectedCommits: FROZEN,
    git: async repoRoot => heads[repoRoot]
  });
  assert.equal(resolved.lishuedu.head, FROZEN.lishuedu);
});

test("command plan keeps all four Sprint0' campaigns on the isolation contract", () => {
  const repositories = Object.fromEntries(Object.entries(FROZEN).map(([project, head]) => [
    project,
    { project, repoRoot: `/tmp/frozen-java-repos/${project}`, head }
  ]));
  const plan = buildSprint0CommandPlan({
    repositories,
    outputDir: "/tmp/v4-sprint0",
    candidateRoot: "/repo"
  });
  assert.match(plan["cold-matrix"].argv.join(" "), /run-isolated-node\.sh.*run-three-repo-cold-matrix\.mjs.*--runs 5/);
  assert.match(plan.bytes.argvByProject.lishuedu.join(" "), /attribute-impact-payload\.mjs/);
  assert.match(plan.progressive.argv.join(" "), /run-progressive-index-three-repo\.mjs/);
  assert.match(plan["first-touch"].argvByProject.cipherlink.join(" "), /run-isolated-jdt-benchmark\.mjs.*--repo-root \{repo\}/);
  assert.match(plan["first-touch"].argvByProject.cipherlink.join(" "), /--workspace-state fresh/);
});

test("dry-run planning refuses an in-checkout output dir and records the quiet-host sample", async () => {
  await assert.rejects(
    () => planV4Sprint0Baseline({
      outputDir: path.join(scriptishRoot(), "artifacts", "v4-sprint0"),
      docsDir: path.join(scriptishRoot(), "docs", "phase-v4"),
      candidateRoot: scriptishRoot(),
      stage: "all",
      dryRun: true,
      repositories: {}
    }, {
      assertHostQuiet: () => ({ loadavg1: 1, logicalCpus: 10, perCpu: 0.1, maxLoadavgPerCpu: 0.7, passed: true }),
      resolveRepositories: async () => ({})
    }),
    /must be outside the candidate source checkout/
  );

  const plan = await planV4Sprint0Baseline({
    outputDir: "/tmp/v4-sprint0-dry",
    docsDir: path.join(scriptishRoot(), "docs", "phase-v4"),
    candidateRoot: scriptishRoot(),
    stage: "all",
    dryRun: true,
    baseline: V4_SPRINT0_IDENTITY_COMMIT,
    repositories: {}
  }, {
    assertHostQuiet: () => ({ loadavg1: 1, logicalCpus: 10, perCpu: 0.1, maxLoadavgPerCpu: 0.7, passed: true }),
    resolveRepositories: async () => Object.fromEntries(Object.entries(FROZEN).map(([project, head]) => [
      project,
      { project, repoRoot: `/tmp/frozen-java-repos/${project}`, head }
    ])),
    inspectHostQuiet: () => ({ loadavg1: 1, logicalCpus: 10, perCpu: 0.1, maxLoadavgPerCpu: 0.7, passed: true }),
    measuredCommit: "eeb6331aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  });
  assert.equal(plan.identity.productionTree, V4_SPRINT0_PRODUCTION_TREE);
  assert.equal(plan.hostQuiet.passed, true);
  assert.ok(plan.commands["cold-matrix"].argv.includes("--runs"));
});

test("descriptor helper refuses the 0-byte Sprint0 failure mode", () => {
  assert.throws(() => descriptorForBytes("empty.json", ""), /zero-byte Sprint0/);
  const descriptor = descriptorForBytes("ok.json", "{\"ok\":true}\n");
  assert.ok(descriptor.bytes > 0);
  assert.match(descriptor.sha256, /^[a-f0-9]{64}$/);
});

test("default repo candidates prefer the frozen /tmp copies", () => {
  const candidates = defaultRepoCandidates("/Users/demo");
  assert.equal(candidates.lishuedu[0], "/tmp/codex-java-v3-golden-20260809/lishuedu");
  assert.equal(candidates.cipherlink[2], "/Users/demo/Documents/program/cipherlink");
});

function scriptishRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}
