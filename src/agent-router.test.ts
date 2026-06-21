// input: Real lishuedu anchors with semanticPolicy=fast.
// output: Assertions for v5 routing, read budgets, test priority, and cross-module suppression metrics.
// pos: Node test coverage for the agent impact router.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRouter } from "./agent-router/index.js";
import { JdtlsSession } from "./jdtls-session.js";
import { SourceIndex } from "./source-index.js";
import type { ImpactOptions } from "./agent-types.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const repoRoot = process.env.LISHUEDU_ROOT || path.resolve(projectDir, "..", "..");
const hasLishueduFixture = process.env.LISHUEDU_ROOT !== undefined;

function router(): AgentRouter {
  return new AgentRouter(repoRoot, new JdtlsSession(repoRoot), new SourceIndex(repoRoot));
}

function tempRouter(root: string): AgentRouter {
  return new AgentRouter(root, new JdtlsSession(root), new SourceIndex(root));
}

function options(overrides: Partial<ImpactOptions>): ImpactOptions {
  return {
    anchors: [],
    mode: "balanced",
    profile: "auto",
    semanticPolicy: "fast",
    semanticTimeoutMs: 1500,
    testReadMode: "defer",
    focusModules: [],
    excludeModules: [],
    taskKeywords: [],
    crossModulePolicy: "auto",
    ...overrides
  };
}

test("controller route infers profile and respects balanced read budget", { skip: !hasLishueduFixture }, async () => {
  const result = await router().impact(options({
    anchors: [{
      file: "modules/school/src/main/java/com/lishu/edu/school/interfaces/web/SchoolTemplateImportController.java",
      line: 109,
      column: 12
    }]
  }));
  assert.equal(result.target.profile, "controller");
  assert.equal(result.readPlan.length, 6);
  assert.equal((result.metrics.semantic as { used: boolean }).used, false);
  assert.ok(result.files.some(file => String(file.path).includes("SchoolTemplateImportAssembler")));
});

test("testReadMode defer keeps tests out of priority read slots", { skip: !hasLishueduFixture }, async () => {
  const result = await router().impact(options({
    anchors: [{
      file: "modules/integration/src/main/java/com/lishu/edu/integration/domain/port/StorageGateway.java",
      line: 21,
      column: 28
    }],
    profile: "port"
  }));
  const fileById = new Map(result.files.map(file => [file.id, file]));
  const priorityTest = result.readPlan
    .filter(item => item.priority !== "P2")
    .map(item => fileById.get(item.fileId))
    .some(file => file?.sourceSet === "test");
  assert.equal(priorityTest, false);
  assert.ok(Number(result.suppressed.crossModuleConsumers) > 0);
});

test("readPlanMaxItems and excludeModules are honored", { skip: !hasLishueduFixture }, async () => {
  const result = await router().impact(options({
    anchors: [{
      file: "modules/benefits/src/main/java/com/lishu/edu/benefits/interfaces/dto/ParentStudentBenefitItemResponse.java",
      line: 19,
      column: 16
    }],
    profile: "dto",
    readPlanMaxItems: 3,
    excludeModules: ["paper", "exercisebook"]
  }));
  assert.equal(result.readPlan.length, 3);
  assert.equal(result.files.some(file => ["paper", "exercisebook"].includes(String(file.module))), false);
});

test("new Java anchor roles have explicit routing instead of service fallback", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-roles-"));
  await mkdir(path.join(root, "modules", "demo", "src", "main", "java", "com", "acme", "demo", "infrastructure", "entity"), { recursive: true });
  await mkdir(path.join(root, "modules", "demo", "src", "main", "java", "com", "acme", "demo", "infrastructure", "mapper"), { recursive: true });
  await mkdir(path.join(root, "modules", "demo", "src", "main", "java", "com", "acme", "demo", "application"), { recursive: true });
  await mkdir(path.join(root, "modules", "demo", "src", "main", "java", "com", "acme", "demo", "interfaces", "vo"), { recursive: true });
  await mkdir(path.join(root, "modules", "demo", "src", "main", "resources", "mapper"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "modules", "demo", "src", "main", "java", "com", "acme", "demo", "infrastructure", "entity", "UserEntity.java"), "package com.acme.demo.infrastructure.entity;\npublic class UserEntity { public Long id() { return 1L; } }\n");
  await writeFile(path.join(root, "modules", "demo", "src", "main", "java", "com", "acme", "demo", "infrastructure", "mapper", "UserMapper.java"), "package com.acme.demo.infrastructure.mapper;\npublic interface UserMapper { UserEntity findUser(Long id); }\n");
  await writeFile(path.join(root, "modules", "demo", "src", "main", "java", "com", "acme", "demo", "application", "UserSyncJob.java"), "package com.acme.demo.application;\npublic class UserSyncJob { public void syncUser() {} }\n");
  await writeFile(path.join(root, "modules", "demo", "src", "main", "java", "com", "acme", "demo", "application", "UserChangedListener.java"), "package com.acme.demo.application;\npublic class UserChangedListener { public void onUserChanged() {} }\n");
  await writeFile(path.join(root, "modules", "demo", "src", "main", "java", "com", "acme", "demo", "interfaces", "vo", "UserVO.java"), "package com.acme.demo.interfaces.vo;\npublic class UserVO { public Long id() { return 1L; } }\n");
  await writeFile(path.join(root, "modules", "demo", "src", "main", "resources", "mapper", "UserMapper.xml"), "<mapper namespace=\"UserMapper\"><select id=\"findUser\">select * from user</select></mapper>\n");

  const cases = [
    {
      file: "modules/demo/src/main/java/com/acme/demo/infrastructure/entity/UserEntity.java",
      expectedProfile: "entity",
      reason: /entity mapping/
    },
    {
      file: "modules/demo/src/main/java/com/acme/demo/infrastructure/mapper/UserMapper.java",
      expectedProfile: "mapper",
      reason: /mapper interface/
    },
    {
      file: "modules/demo/src/main/java/com/acme/demo/application/UserSyncJob.java",
      expectedProfile: "job",
      reason: /scheduled job/
    },
    {
      file: "modules/demo/src/main/java/com/acme/demo/application/UserChangedListener.java",
      expectedProfile: "listener",
      reason: /event listener/
    },
    {
      file: "modules/demo/src/main/java/com/acme/demo/interfaces/vo/UserVO.java",
      expectedProfile: "vo",
      reason: /VO\/view/
    }
  ];

  for (const item of cases) {
    const result = await tempRouter(root).impact(options({
      anchors: [{ file: item.file, line: 2, column: 14 }]
    }));
    assert.equal(result.target.profile, item.expectedProfile);
    assert.ok(result.rgSummary.sections.some(section => item.reason.test(section.reason)));
  }
});

test("plain Maven repos without modules/apps still get rg expansion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-maven-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await mkdir(path.join(root, "exam-management", "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "DemoController.java"), "package demo;\npublic class DemoController { public void saveDemo() { new DemoService().saveDemo(); } }\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "DemoService.java"), "package demo;\npublic class DemoService { public void saveDemo() {} }\n");
  await writeFile(path.join(root, "exam-management", "src", "main", "java", "demo", "FieldsController.java"), "package demo;\npublic class FieldsController { public void insert() { new FieldsService().insert(); } }\n");
  await writeFile(path.join(root, "exam-management", "src", "main", "java", "demo", "FieldsService.java"), "package demo;\npublic class FieldsService { public void insert() {} }\n");

  const result = await tempRouter(root).impact(options({
    anchors: [{ file: "src/main/java/demo/DemoController.java", line: 2, column: 45 }],
    profile: "controller"
  }));
  const moduleResult = await tempRouter(root).impact(options({
    anchors: [{ file: "exam-management/src/main/java/demo/FieldsController.java", line: 2, column: 48 }],
    profile: "controller"
  }));

  assert.ok(Number(result.counts.rgFiles) > 0);
  assert.ok(result.files.some(file => String(file.path).includes("DemoService.java")));
  assert.ok(Number(moduleResult.counts.rgFiles) > 0);
  assert.ok(moduleResult.files.some(file => String(file.path).includes("FieldsService.java")));
});
