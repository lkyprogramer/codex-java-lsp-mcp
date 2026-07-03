// input: Real lishuedu anchors with semanticPolicy=fast.
// output: Assertions for v5 routing, read budgets, test priority, and cross-module suppression metrics.
// pos: Node test coverage for the agent impact router.
import assert from "node:assert/strict";
import test from "node:test";
import { utimesSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { AgentRouter } from "./agent-router/index.js";
import { EdgeStore } from "./edge-store.js";
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

test("annotation profile signal beats misleading path names", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-profile-"));
  await mkdir(path.join(root, "src", "main", "java", "demo", "controller"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "controller", "MisplacedService.java"), [
    "package demo.controller;",
    "@Service",
    "public class MisplacedService { public void applyOrder() {} }",
    ""
  ].join("\n"));

  const result = await tempRouter(root).impact(options({
    anchors: [{ file: "src/main/java/demo/controller/MisplacedService.java", line: 3, column: 46 }]
  }));

  assert.equal(result.target.profile, "service");
});

test("verbosity trims diagnostics without dropping core routing output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-compact-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "DemoController.java"), "package demo;\npublic class DemoController { public void saveDemo() { new DemoService().saveDemo(); } }\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "DemoService.java"), "package demo;\npublic class DemoService { public void saveDemo() {} }\n");

  const standard = await tempRouter(root).impact(options({
    anchors: [{ file: "src/main/java/demo/DemoController.java", line: 2, column: 45 }],
    profile: "controller"
  }));
  const compact = await tempRouter(root).impact(options({
    anchors: [{ file: "src/main/java/demo/DemoController.java", line: 2, column: 45 }],
    profile: "controller",
    verbosity: "compact"
  }));
  const diagnostic = await tempRouter(root).impact(options({
    anchors: [{ file: "src/main/java/demo/DemoController.java", line: 2, column: 45 }],
    profile: "controller",
    verbosity: "diagnostic"
  }));

  assert.ok(standard.files.length > 0);
  assert.ok(standard.readPlan.length > 0);
  assert.equal(standard.rgSummary.sections.every(section => section.files.length === 0), true);
  assert.equal(Object.hasOwn(standard.metrics, "phaseMs"), false);
  assert.equal(Object.hasOwn(standard.metrics, "cache"), false);
  assert.equal(Object.hasOwn(standard.metrics, "rgCache"), false);
  assert.equal(Object.hasOwn(standard.metrics, "sourceFacts"), false);
  assert.equal(Object.hasOwn(standard.metrics, "semantic"), true);
  assert.ok(compact.files.length > 0);
  assert.ok(compact.readPlan.length > 0);
  assert.equal(compact.rgSummary.sections.every(section => section.files.length === 0), true);
  assert.ok(compact.evidenceGaps.length <= 2);
  assert.ok(diagnostic.rgSummary.sections.some(section => section.files.length > 0));
  assert.equal(Object.hasOwn(diagnostic.metrics, "phaseMs"), true);
  assert.equal(Object.hasOwn(diagnostic.metrics, "cache"), true);
  assert.equal(Object.hasOwn(diagnostic.metrics, "rgCache"), true);
  assert.equal(Object.hasOwn(diagnostic.metrics, "sourceFacts"), true);
  assert.ok(Number(standard.metrics.outputBytes) < Number(diagnostic.metrics.outputBytes));
  assert.ok(Number(compact.metrics.outputBytes) <= Number(standard.metrics.outputBytes));
});

test("readPlan uses strict method windows only for positions inside methods", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-method-window-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "WindowService.java"), [
    "package demo;",
    "public class WindowService {",
    ...Array.from({ length: 27 }, () => "  int padding;"),
    "  public void targetMethod() {",
    "    int value = 1;",
    "    value++;",
    "  }",
    "",
    "  int afterMethod;",
    "}"
  ].join("\n"));

  const methodResult = await tempRouter(root).impact(options({
    anchors: [{ file: "src/main/java/demo/WindowService.java", line: 31, column: 10 }],
    profile: "service",
    readPlanMaxItems: 1
  }));
  assert.deepEqual(methodResult.readPlan[0], {
    priority: "P0",
    fileId: "F1",
    startLine: 18,
    endLine: 41,
    reason: "anchor symbol and local behavior"
  });

  const classLevelResult = await tempRouter(root).impact(options({
    anchors: [{ file: "src/main/java/demo/WindowService.java", line: 35, column: 7 }],
    profile: "service",
    readPlanMaxItems: 1
  }));
  assert.equal(classLevelResult.readPlan[0].startLine, 11);
  assert.equal(classLevelResult.readPlan[0].endLine, 79);
});

test("semanticPolicy fast does not call semantic verify", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-fast-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "FooService.java"), "package demo;\npublic class FooService { public void applyOrder() {} }\n");
  const session = new FakeSemanticSession();

  await new AgentRouter(root, session as unknown as JdtlsSession, new SourceIndex(root)).impact(options({
    anchors: [{ file: "src/main/java/demo/FooService.java", line: 2, column: 45 }],
    profile: "service",
    semanticPolicy: "fast"
  }));

  assert.equal(session.referencesCalls, 0);
});

test("auto semantic verify is skipped when semantic seed is skipped", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-auto-verify-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "FooController.java"), "package demo;\npublic class FooController { public void applyOrder() {} }\n");
  const session = new FakeSemanticSession();

  const result = await new AgentRouter(root, session as unknown as JdtlsSession, new SourceIndex(root)).impact(options({
    anchors: [{ file: "src/main/java/demo/FooController.java", line: 2, column: 48 }],
    profile: "controller",
    semanticPolicy: "auto",
    verbosity: "diagnostic"
  }));

  const semantic = result.metrics.semantic as { used: boolean; verifySkipped: boolean };
  assert.equal(session.referencesCalls, 0);
  assert.equal(semantic.used, false);
  assert.equal(semantic.verifySkipped, true);
});

test("required semantic verify promotes reference candidates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-references-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "FooService.java"), "package demo;\npublic class FooService { public void applyOrder() {} }\n");
  const caller = path.join(root, "src", "main", "java", "demo", "OtherController.java");
  await writeFile(caller, "package demo;\npublic class OtherController { public void route() {} }\n");
  const session = new FakeSemanticSession([{ uri: pathToFileURL(caller).toString(), range: { start: { line: 1, character: 13 }, end: { line: 1, character: 28 } } }]);

  const result = await new AgentRouter(root, session as unknown as JdtlsSession, new SourceIndex(root)).impact(options({
    anchors: [{ file: "src/main/java/demo/FooService.java", line: 2, column: 45 }],
    profile: "service",
    semanticPolicy: "required",
    verbosity: "diagnostic"
  }));

  const referenced = result.files.find(file => String(file.path).endsWith("OtherController.java")) as Record<string, unknown> | undefined;
  assert.equal(session.referencesCalls, 1);
  assert.equal(referenced?.confidence, "high");
  assert.deepEqual(referenced?.verifiedBy, ["reference"]);
});

test("semantic verify timeout falls back to non-semantic candidates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-semantic-timeout-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "FooService.java"), "package demo;\npublic class FooService { public void applyOrder() {} }\n");
  const session = new FakeSemanticSession();
  session.failReferences = true;

  const result = await new AgentRouter(root, session as unknown as JdtlsSession, new SourceIndex(root)).impact(options({
    anchors: [{ file: "src/main/java/demo/FooService.java", line: 2, column: 45 }],
    profile: "service",
    semanticPolicy: "required"
  }));

  assert.equal(result.files.some(file => String(file.path).endsWith("FooService.java")), true);
  assert.equal((result.metrics.semantic as { timeout?: boolean }).timeout, true);
});

test("required semantic verify promotes type hierarchy subtype candidates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-typehierarchy-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "PaymentGateway.java"), "package demo;\npublic interface PaymentGateway { void pay(); }\n");
  const subtype = path.join(root, "src", "main", "java", "demo", "StripeGateway.java");
  await writeFile(subtype, "package demo;\npublic class StripeGateway implements PaymentGateway { public void pay() {} }\n");
  const session = new FakeSemanticSession([], [{ depth: 1, from: { uri: pathToFileURL(subtype).toString(), range: { start: { line: 1, character: 13 }, end: { line: 1, character: 26 } } }, to: {} }]);

  const result = await new AgentRouter(root, session as unknown as JdtlsSession, new SourceIndex(root)).impact(options({
    anchors: [{ file: "src/main/java/demo/PaymentGateway.java", line: 2, column: 18 }],
    profile: "port",
    semanticPolicy: "required",
    verbosity: "diagnostic"
  }));

  const impl = result.files.find(file => String(file.path).endsWith("StripeGateway.java")) as Record<string, unknown> | undefined;
  assert.equal(session.typeHierarchyCalls, 1);
  assert.ok((impl?.verifiedBy as string[]).includes("typeHierarchy"));
});

test("cached type graph promotes implementers before rg naming fallback", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-typegraph-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "PaymentGateway.java"), "package demo;\npublic interface PaymentGateway { void pay(); }\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "StripeGateway.java"), "package demo;\npublic class StripeGateway implements PaymentGateway { public void pay() {} }\n");
  const sourceIndex = new SourceIndex(root);
  sourceIndex.factsFor(path.join(root, "src", "main", "java", "demo", "PaymentGateway.java"));
  sourceIndex.factsFor(path.join(root, "src", "main", "java", "demo", "StripeGateway.java"));

  const result = await new AgentRouter(root, new JdtlsSession(root), sourceIndex).impact(options({
    anchors: [{ file: "src/main/java/demo/PaymentGateway.java", line: 2, column: 18 }],
    profile: "port",
    semanticPolicy: "fast",
    verbosity: "diagnostic"
  }));

  const impl = result.files.find(file => String(file.path).endsWith("StripeGateway.java")) as Record<string, unknown> | undefined;
  assert.ok((impl?.verifiedBy as string[]).includes("typeGraph"));
});

test("signature type references promote typed collaborators", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-type-reference-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "EnrollmentService.java"), [
    "package demo;",
    "public class EnrollmentService {",
    "  private SchoolTemplateRepository repository;",
    "  public void confirm() {",
    "  }",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(root, "src", "main", "java", "demo", "SchoolTemplateRepository.java"), "package demo;\npublic interface SchoolTemplateRepository {}\n");

  const result = await tempRouter(root).impact(options({
    anchors: [{ file: "src/main/java/demo/EnrollmentService.java", line: 2, column: 15 }],
    profile: "service",
    semanticPolicy: "fast",
    taskKeywords: ["ExistingRepository"],
    verbosity: "diagnostic"
  }));

  const repository = result.files.find(file => String(file.path).endsWith("SchoolTemplateRepository.java")) as Record<string, unknown> | undefined;
  assert.ok((repository?.verifiedBy as string[] | undefined)?.includes("typeReference"));
});

test("type reference keeps source-order collaborators ahead of wildcard noise", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-type-reference-order-"));
  const appDir = path.join(root, "src", "main", "java", "demo", "app");
  const dataDir = path.join(root, "src", "main", "java", "demo", "data");
  await mkdir(appDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(appDir, "ApplyInfoServiceImpl.java"), [
    "package demo.app;",
    "import demo.data.*;",
    "public class ApplyInfoServiceImpl {",
    "  private PositionTemplate positionTemplate;",
    ...Array.from({ length: 24 }, (_, index) => `  private Alpha${String(index).padStart(2, "0")} alpha${index};`),
    "  public void save() {}",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(dataDir, "PositionTemplate.java"), "package demo.data;\npublic class PositionTemplate {}\n");
  for (let index = 0; index < 24; index += 1) {
    const name = `Alpha${String(index).padStart(2, "0")}`;
    await writeFile(path.join(dataDir, `${name}.java`), `package demo.data;\npublic class ${name} {}\n`);
  }

  const result = await tempRouter(root).impact(options({
    anchors: [{ file: "src/main/java/demo/app/ApplyInfoServiceImpl.java", line: 3, column: 15 }],
    profile: "service",
    semanticPolicy: "fast",
    verbosity: "diagnostic"
  }));

  const collaborator = result.files.find(file => String(file.path).endsWith("PositionTemplate.java")) as Record<string, unknown> | undefined;
  assert.ok((collaborator?.verifiedBy as string[] | undefined)?.includes("typeReference"));
});

test("controller type references promote field collaborators", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-controller-type-reference-"));
  const webDir = path.join(root, "src", "main", "java", "demo", "web");
  const serviceDir = path.join(root, "src", "main", "java", "demo", "service");
  const dtoDir = path.join(root, "src", "main", "java", "demo", "dto");
  await mkdir(webDir, { recursive: true });
  await mkdir(serviceDir, { recursive: true });
  await mkdir(dtoDir, { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(webDir, "ExaminationController.java"), [
    "package demo.web;",
    "import demo.service.*;",
    "import demo.dto.*;",
    "public class ExaminationController {",
    "  private PositionService positionService;",
    ...Array.from({ length: 24 }, (_, index) => `  private Alpha${String(index).padStart(2, "0")}DTO alpha${index};`),
    "  public void select() {}",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(serviceDir, "PositionService.java"), "package demo.service;\npublic interface PositionService {}\n");
  for (let index = 0; index < 24; index += 1) {
    const name = `Alpha${String(index).padStart(2, "0")}DTO`;
    await writeFile(path.join(dtoDir, `${name}.java`), `package demo.dto;\npublic record ${name}() {}\n`);
  }

  const result = await tempRouter(root).impact(options({
    anchors: [{ file: "src/main/java/demo/web/ExaminationController.java", line: 3, column: 15 }],
    profile: "controller",
    semanticPolicy: "fast",
    verbosity: "diagnostic"
  }));

  const collaborator = result.files.find(file => String(file.path).endsWith("PositionService.java")) as Record<string, unknown> | undefined;
  assert.ok((collaborator?.verifiedBy as string[] | undefined)?.includes("typeReference"));
});

test("method type references promote anchor method collaborators ahead of class noise", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-method-type-reference-"));
  const appDir = path.join(root, "src", "main", "java", "demo", "app");
  const dtoDir = path.join(root, "src", "main", "java", "demo", "dto");
  const noiseDir = path.join(root, "src", "main", "java", "demo", "noise");
  await mkdir(appDir, { recursive: true });
  await mkdir(dtoDir, { recursive: true });
  await mkdir(noiseDir, { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(appDir, "ApplyInfoServiceImpl.java"), [
    "package demo.app;",
    "import demo.dto.*;",
    "import demo.noise.*;",
    "public class ApplyInfoServiceImpl {",
    ...Array.from({ length: 24 }, (_, index) => `  private Alpha${String(index).padStart(2, "0")} alpha${index};`),
    "  public ApplyInfo saveApplyBasicInfo(ApplyInfoUpdateDTO command) {",
    "    return new ApplyInfo();",
    "  }",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(dtoDir, "ApplyInfo.java"), "package demo.dto;\npublic class ApplyInfo {}\n");
  await writeFile(path.join(dtoDir, "ApplyInfoUpdateDTO.java"), "package demo.dto;\npublic record ApplyInfoUpdateDTO() {}\n");
  for (let index = 0; index < 24; index += 1) {
    const name = `Alpha${String(index).padStart(2, "0")}`;
    await writeFile(path.join(noiseDir, `${name}.java`), `package demo.noise;\npublic class ${name} {}\n`);
  }

  const result = await tempRouter(root).impact(options({
    anchors: [{ file: "src/main/java/demo/app/ApplyInfoServiceImpl.java", line: 29, column: 20 }],
    profile: "service",
    semanticPolicy: "fast",
    verbosity: "diagnostic"
  }));

  const collaborator = result.files.find(file => String(file.path).endsWith("ApplyInfoUpdateDTO.java"));
  assert.equal(Array.isArray(collaborator?.verifiedBy) && collaborator.verifiedBy.includes("typeReference"), true);
});

test("method type references promote referenced interface implementers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-method-interface-"));
  const appDir = path.join(root, "src", "main", "java", "demo", "app");
  const serviceDir = path.join(root, "src", "main", "java", "demo", "service");
  await mkdir(appDir, { recursive: true });
  await mkdir(serviceDir, { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(appDir, "CheckoutService.java"), [
    "package demo.app;",
    "import demo.service.*;",
    "public class CheckoutService {",
    "  public void checkout(PaymentService paymentService) {",
    "    paymentService.pay();",
    "  }",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(serviceDir, "PaymentService.java"), "package demo.service;\npublic interface PaymentService { void pay(); }\n");
  await writeFile(path.join(serviceDir, "StripePaymentService.java"), [
    "package demo.service;",
    "public class StripePaymentService implements PaymentService {",
    "  public void pay() {}",
    "}",
    ""
  ].join("\n"));

  const result = await tempRouter(root).impact(options({
    anchors: [{ file: "src/main/java/demo/app/CheckoutService.java", line: 4, column: 15 }],
    profile: "service",
    semanticPolicy: "fast",
    verbosity: "diagnostic"
  }));

  const impl = result.files.find(file => String(file.path).endsWith("StripePaymentService.java"));
  assert.equal(Array.isArray(impl?.verifiedBy) && impl.verifiedBy.includes("typeGraph"), true);
});

test("type reference diagnostics report scanned, skipped, and added candidates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-type-reference-metrics-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "EnrollmentService.java"), [
    "package demo;",
    "public class EnrollmentService {",
    "  private ExistingRepository existingRepository;",
    "  private NewRepository newRepository;",
    "  public void confirm() {",
    "  }",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(root, "src", "main", "java", "demo", "ExistingRepository.java"), "package demo;\npublic interface ExistingRepository {}\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "NewRepository.java"), "package demo;\npublic interface NewRepository {}\n");
  const sourceIndex = new SourceIndex(root);
  for (const file of ["EnrollmentService.java", "ExistingRepository.java"]) {
    sourceIndex.factsFor(path.join(root, "src", "main", "java", "demo", file));
  }

  const result = await new AgentRouter(root, new JdtlsSession(root), sourceIndex).impact(options({
    anchors: [{ file: "src/main/java/demo/EnrollmentService.java", line: 2, column: 15 }],
    profile: "service",
    semanticPolicy: "fast",
    taskKeywords: ["existing"],
    verbosity: "diagnostic"
  }));

  const metrics = result.metrics.typeReference as Record<string, unknown> | undefined;
  assert.equal(metrics?.scannedPatterns, 2);
  assert.equal(metrics?.skippedExisting, 1);
  assert.equal(metrics?.addedCandidates, 1);
  assert.equal(metrics?.indexMisses, 2);
  assert.equal(metrics?.cacheMisses, 3);
  assert.equal(typeof metrics?.cacheMissElapsedMs, "number");
});

test("required semantic policy skips local type reference expansion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-type-reference-required-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "CebOrderRequest.java"), "package demo;\npublic record CebOrderRequest(String id) {}\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "CebPayServiceImpl.java"), [
    "package demo;",
    "public class CebPayServiceImpl {",
    "  public void create(CebOrderRequest request) {",
    "  }",
    "}",
    ""
  ].join("\n"));

  const session = new FakeSemanticSession();
  const result = await new AgentRouter(root, session as unknown as JdtlsSession, new SourceIndex(root)).impact(options({
    anchors: [{ file: "src/main/java/demo/CebOrderRequest.java", line: 2, column: 15 }],
    profile: "dto",
    semanticPolicy: "required",
    verbosity: "diagnostic"
  }));

  assert.equal(result.files.some(file => ((file as Record<string, unknown>).verifiedBy as string[] | undefined)?.includes("typeReference")), false);
});

test("pure type references do not evict graph candidates from read plan", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-type-reference-priority-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "PaymentGateway.java"), [
    "package demo;",
    "public interface PaymentGateway {",
    "  PaymentResult pay(PaymentCommand command);",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(root, "src", "main", "java", "demo", "PaymentCommand.java"), "package demo;\npublic class PaymentCommand {}\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "PaymentResult.java"), "package demo;\npublic class PaymentResult {}\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "AliyunPaymentGateway.java"), "package demo;\npublic class AliyunPaymentGateway implements PaymentGateway { public PaymentResult pay(PaymentCommand command) { return null; } }\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "StubPaymentGateway.java"), "package demo;\npublic class StubPaymentGateway implements PaymentGateway { public PaymentResult pay(PaymentCommand command) { return null; } }\n");
  const sourceIndex = new SourceIndex(root);
  for (const file of ["PaymentGateway.java", "PaymentCommand.java", "PaymentResult.java", "AliyunPaymentGateway.java", "StubPaymentGateway.java"]) {
    sourceIndex.factsFor(path.join(root, "src", "main", "java", "demo", file));
  }

  const result = await new AgentRouter(root, new JdtlsSession(root), sourceIndex).impact(options({
    anchors: [{ file: "src/main/java/demo/PaymentGateway.java", line: 2, column: 18 }],
    profile: "port",
    semanticPolicy: "fast",
    readPlanMaxItems: 3,
    verbosity: "diagnostic"
  }));
  const readPaths = readPlanPaths(result);

  assert.ok(readPaths.includes("src/main/java/demo/AliyunPaymentGateway.java"));
  assert.ok(readPaths.includes("src/main/java/demo/StubPaymentGateway.java"));
});

test("import graph recalls method-body collaborators invisible to signature scan", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-import-forward-"));
  await mkdir(path.join(root, "src", "main", "java", "demo", "application"), { recursive: true });
  await mkdir(path.join(root, "src", "main", "java", "demo", "dto"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "application", "ApplyInfoServiceImpl.java"), [
    "package demo.application;",
    "import demo.dto.ApplyInfoUpdateDTO;",
    "public class ApplyInfoServiceImpl {",
    "  public void save() {",
    "    ApplyInfoUpdateDTO dto = null;",
    "  }",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(root, "src", "main", "java", "demo", "dto", "ApplyInfoUpdateDTO.java"), "package demo.dto;\npublic class ApplyInfoUpdateDTO {}\n");
  const sourceIndex = new SourceIndex(root);
  sourceIndex.factsFor(path.join(root, "src", "main", "java", "demo", "dto", "ApplyInfoUpdateDTO.java"));

  const result = await new AgentRouter(root, new JdtlsSession(root), sourceIndex).impact(options({
    anchors: [{ file: "src/main/java/demo/application/ApplyInfoServiceImpl.java", line: 3, column: 15 }],
    profile: "service",
    semanticPolicy: "fast",
    verbosity: "diagnostic"
  }));

  const dto = result.files.find(file => String(file.path).endsWith("ApplyInfoUpdateDTO.java")) as Record<string, unknown> | undefined;
  assert.ok((dto?.verifiedBy as string[] | undefined)?.includes("importGraph"));
});

test("import graph recalls cross-module importers outside rg roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-import-reverse-"));
  await mkdir(path.join(root, "modules", "core", "src", "main", "java", "demo", "core"), { recursive: true });
  await mkdir(path.join(root, "modules", "flow", "src", "main", "java", "demo", "flow"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "modules", "core", "src", "main", "java", "demo", "core", "PositionQuery.java"), "package demo.core;\npublic class PositionQuery {}\n");
  await writeFile(path.join(root, "modules", "flow", "src", "main", "java", "demo", "flow", "SubmitFlowHandler.java"), [
    "package demo.flow;",
    "import demo.core.*;",
    "public class SubmitFlowHandler {",
    "  public void handle() { PositionQuery query = null; }",
    "}",
    ""
  ].join("\n"));
  const sourceIndex = new SourceIndex(root);
  sourceIndex.factsFor(path.join(root, "modules", "flow", "src", "main", "java", "demo", "flow", "SubmitFlowHandler.java"));

  const result = await new AgentRouter(root, new JdtlsSession(root), sourceIndex).impact(options({
    anchors: [{ file: "modules/core/src/main/java/demo/core/PositionQuery.java", line: 2, column: 15 }],
    profile: "dto",
    semanticPolicy: "fast",
    verbosity: "diagnostic"
  }));

  const handler = result.files.find(file => String(file.path).endsWith("SubmitFlowHandler.java")) as Record<string, unknown> | undefined;
  assert.ok((handler?.verifiedBy as string[] | undefined)?.includes("importGraph"));
});

test("required semantic policy skips import graph expansion", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-import-required-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "OrderQuery.java"), "package demo;\npublic class OrderQuery {}\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "OrderFlow.java"), [
    "package demo;",
    "import demo.OrderQuery;",
    "public class OrderFlow {}",
    ""
  ].join("\n"));

  const session = new FakeSemanticSession();
  const result = await new AgentRouter(root, session as unknown as JdtlsSession, new SourceIndex(root)).impact(options({
    anchors: [{ file: "src/main/java/demo/OrderQuery.java", line: 2, column: 15 }],
    profile: "dto",
    semanticPolicy: "required",
    verbosity: "diagnostic"
  }));

  assert.equal(result.files.some(file => ((file as Record<string, unknown>).verifiedBy as string[] | undefined)?.includes("importGraph")), false);
});

test("import graph diagnostics report scanned and added candidates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-import-metrics-"));
  await mkdir(path.join(root, "src", "main", "java", "demo", "application"), { recursive: true });
  await mkdir(path.join(root, "src", "main", "java", "demo", "dto"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "application", "ApplyInfoServiceImpl.java"), [
    "package demo.application;",
    "import demo.dto.ApplyInfoUpdateDTO;",
    "public class ApplyInfoServiceImpl {",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(root, "src", "main", "java", "demo", "dto", "ApplyInfoUpdateDTO.java"), "package demo.dto;\npublic class ApplyInfoUpdateDTO {}\n");
  const sourceIndex = new SourceIndex(root);
  sourceIndex.factsFor(path.join(root, "src", "main", "java", "demo", "dto", "ApplyInfoUpdateDTO.java"));

  const result = await new AgentRouter(root, new JdtlsSession(root), sourceIndex).impact(options({
    anchors: [{ file: "src/main/java/demo/application/ApplyInfoServiceImpl.java", line: 3, column: 15 }],
    profile: "service",
    semanticPolicy: "fast",
    verbosity: "diagnostic"
  }));

  const metrics = result.metrics.importGraph as Record<string, unknown> | undefined;
  assert.equal(metrics?.scannedAnchors, 1);
  assert.ok(Number(metrics?.addedCandidates) >= 1);
  assert.equal(typeof metrics?.elapsedMs, "number");
});

test("evidence budget keeps structural collaborator under naming flood", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-budget-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "OrderService.java"), [
    "package demo;",
    "public class OrderService {",
    "  private OrderPolicy policy;",
    "  public void submitOrder() {",
    "  }",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(root, "src", "main", "java", "demo", "OrderPolicy.java"), "package demo;\npublic interface OrderPolicy {}\n");
  const flood = "OrderService OrderService OrderService OrderService OrderService\n".repeat(12);
  for (const name of ["OrderHelperA", "OrderHelperB", "OrderHelperC", "OrderHelperD", "OrderHelperE"]) {
    await writeFile(path.join(root, "src", "main", "java", "demo", `${name}.java`), `package demo;\n${flood}public class ${name} {}\n`);
  }
  const sourceIndex = new SourceIndex(root);
  sourceIndex.factsFor(path.join(root, "src", "main", "java", "demo", "OrderPolicy.java"));

  const result = await new AgentRouter(root, new JdtlsSession(root), sourceIndex).impact(options({
    anchors: [{ file: "src/main/java/demo/OrderService.java", line: 2, column: 15 }],
    profile: "service",
    semanticPolicy: "fast",
    readPlanMaxItems: 4,
    verbosity: "diagnostic"
  }));

  const readPaths = readPlanPaths(result);
  assert.ok(readPaths.includes("src/main/java/demo/OrderPolicy.java"));
  assert.ok(readPaths.includes("src/main/java/demo/OrderService.java"));
});

test("diagnostic score breakdown sums to final score", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-breakdown-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "DemoController.java"), "package demo;\npublic class DemoController { public void saveDemo() { new DemoService().saveDemo(); } }\n");
  await writeFile(path.join(root, "src", "main", "java", "demo", "DemoService.java"), "package demo;\npublic class DemoService { public void saveDemo() {} }\n");

  const result = await tempRouter(root).impact(options({
    anchors: [{ file: "src/main/java/demo/DemoController.java", line: 2, column: 45 }],
    profile: "controller",
    verbosity: "diagnostic"
  }));

  for (const file of result.files) {
    const breakdown = file.scoreBreakdown as Array<{ delta: number }> | undefined;
    assert.ok(breakdown && breakdown.length > 0);
    assert.equal(breakdown.reduce((sum, item) => sum + item.delta, 0), file.score);
  }
});

test("L1 structural signals are scored on a real collaborator candidate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-l1-"));
  const base = path.join(root, "modules", "order", "src", "main", "java", "com", "x", "order");
  await mkdir(path.join(base, "app"), { recursive: true });
  await mkdir(path.join(base, "infra"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(base, "app", "OrderService.java"), [
    "package com.x.order.app;",
    "@Service",
    "public class OrderService { public void placeOrder() { } }",
    ""
  ].join("\n"));
  await writeFile(path.join(base, "infra", "OrderRepository.java"), [
    "package com.x.order.infra;",
    "@Repository",
    "public class OrderRepository { public void saveOrder(Long orderId) { } }",
    ""
  ].join("\n"));

  const result = await tempRouter(root).impact(options({
    anchors: [{ file: "modules/order/src/main/java/com/x/order/app/OrderService.java", line: 3, column: 21 }],
    taskKeywords: ["order"],
    verbosity: "diagnostic"
  }));

  const repo = result.files.find(file => String(file.path).endsWith("OrderRepository.java"));
  assert.ok(repo, "OrderRepository should be returned as a candidate");
  const breakdown = new Map(((repo.scoreBreakdown as Array<{ id: string; delta: number }>) || []).map(item => [item.id, item.delta]));
  assert.equal(breakdown.get("finalize.structural.annotation"), 50);
  assert.equal(breakdown.get("finalize.structural.package"), 18);
});

test("controller recall includes method-infix request response and assembler", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-controller-recall-"));
  await mkdir(path.join(root, "modules", "client", "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "modules", "client", "src", "main", "java", "demo", "ClientUpdateController.java"), [
    "package demo;",
    "public class ClientUpdateController {",
    "  public ClientUpdateCheckResponse check(ClientUpdateCheckRequest request) {",
    "    return ClientResponseAssembler.toResponse(request);",
    "  }",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(root, "modules", "client", "src", "main", "java", "demo", "ClientUpdateCheckRequest.java"), "package demo; public record ClientUpdateCheckRequest(String version) {}\n");
  await writeFile(path.join(root, "modules", "client", "src", "main", "java", "demo", "ClientUpdateCheckResponse.java"), "package demo; public record ClientUpdateCheckResponse(String version) {}\n");
  await writeFile(path.join(root, "modules", "client", "src", "main", "java", "demo", "ClientResponseAssembler.java"), "package demo; public class ClientResponseAssembler { static ClientUpdateCheckResponse toResponse(ClientUpdateCheckRequest request) { return null; } }\n");

  const result = await tempRouter(root).impact(options({
    anchors: [{ file: "modules/client/src/main/java/demo/ClientUpdateController.java", line: 3, column: 42 }],
    profile: "controller",
    focusModules: ["client"],
    taskKeywords: ["client", "update", "check"]
  }));
  const readPaths = readPlanPaths(result);

  assert.ok(readPaths.includes("modules/client/src/main/java/demo/ClientUpdateCheckRequest.java"));
  assert.ok(readPaths.includes("modules/client/src/main/java/demo/ClientUpdateCheckResponse.java"));
  assert.ok(readPaths.includes("modules/client/src/main/java/demo/ClientResponseAssembler.java"));
});

test("service recall includes executor and result collaborators", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-service-recall-"));
  await mkdir(path.join(root, "exam-checkRule", "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project><packaging>pom</packaging><modules><module>exam-checkRule</module></modules></project>\n");
  await writeFile(path.join(root, "exam-checkRule", "src", "main", "java", "demo", "RuleEngine.java"), [
    "package demo;",
    "public class RuleEngine {",
    "  public FinalCheckResult execute(CheckRule rule) {",
    "    RuleExecutor executor = null;",
    "    CheckResult checkResult = executor.execute(rule);",
    "    return FinalCheckResult.from(checkResult);",
    "  }",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(root, "exam-checkRule", "src", "main", "java", "demo", "RuleExecutor.java"), "package demo; public interface RuleExecutor { CheckResult execute(CheckRule rule); }\n");
  for (const executor of ["AbstractRuleExecutor", "DateRuleExecutor", "DistrictRuleExecutor", "SelectRuleExecutor", "StringRuleExecutor"]) {
    await writeFile(path.join(root, "exam-checkRule", "src", "main", "java", "demo", `${executor}.java`), `package demo; public class ${executor} implements RuleExecutor { public CheckResult execute(CheckRule rule) { return null; } }\n`);
  }
  await writeFile(path.join(root, "exam-checkRule", "src", "main", "java", "demo", "CheckResult.java"), "package demo; public class CheckResult {}\n");
  await writeFile(path.join(root, "exam-checkRule", "src", "main", "java", "demo", "FinalCheckResult.java"), "package demo; public class FinalCheckResult { static FinalCheckResult from(CheckResult result) { return null; } }\n");

  const result = await tempRouter(root).impact(options({
    anchors: [{ file: "exam-checkRule/src/main/java/demo/RuleEngine.java", line: 3, column: 31 }],
    profile: "service",
    focusModules: ["exam-checkRule"],
    taskKeywords: ["rule", "execute", "check"]
  }));
  const readPaths = readPlanPaths(result);

  assert.ok(readPaths.includes("exam-checkRule/src/main/java/demo/RuleExecutor.java"));
  assert.ok(readPaths.includes("exam-checkRule/src/main/java/demo/CheckResult.java"));
  assert.ok(readPaths.includes("exam-checkRule/src/main/java/demo/FinalCheckResult.java"));
});

test("port recall includes action contracts and implementations under keyword noise", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-port-recall-"));
  await mkdir(path.join(root, "modules", "integration", "src", "main", "java", "demo"), { recursive: true });
  await mkdir(path.join(root, "modules", "report", "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "modules", "integration", "src", "main", "java", "demo", "StorageGateway.java"), [
    "package demo;",
    "public interface StorageGateway {",
    "  StorageSignedUrlResult getSignedUrl(StorageSignedUrlCommand command);",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(root, "modules", "integration", "src", "main", "java", "demo", "StorageSignedUrlCommand.java"), "package demo; public record StorageSignedUrlCommand(String key) {}\n");
  await writeFile(path.join(root, "modules", "integration", "src", "main", "java", "demo", "StorageSignedUrlResult.java"), "package demo; public record StorageSignedUrlResult(String url) {}\n");
  await writeFile(path.join(root, "modules", "integration", "src", "main", "java", "demo", "AliyunOssGateway.java"), "package demo; public class AliyunOssGateway implements StorageGateway { public StorageSignedUrlResult getSignedUrl(StorageSignedUrlCommand command) { return null; } }\n");
  await writeFile(path.join(root, "modules", "integration", "src", "main", "java", "demo", "StubStorageGateway.java"), "package demo; public class StubStorageGateway implements StorageGateway { public StorageSignedUrlResult getSignedUrl(StorageSignedUrlCommand command) { return null; } }\n");
  for (const file of ["ReportAssembler", "ReportMockFactory", "ReportExportService", "ReportConfig"]) {
    await writeFile(path.join(root, "modules", "report", "src", "main", "java", "demo", `${file}.java`), `package demo; public class ${file} { String report = "report"; }\n`);
  }

  const result = await tempRouter(root).impact(options({
    anchors: [{ file: "modules/integration/src/main/java/demo/StorageGateway.java", line: 3, column: 28 }],
    profile: "port",
    focusModules: ["integration"],
    taskKeywords: ["storage", "signed", "url", "report"]
  }));
  const readPaths = readPlanPaths(result);

  assert.ok(readPaths.includes("modules/integration/src/main/java/demo/StorageSignedUrlCommand.java"));
  assert.ok(readPaths.includes("modules/integration/src/main/java/demo/StorageSignedUrlResult.java"));
  assert.ok(readPaths.includes("modules/integration/src/main/java/demo/AliyunOssGateway.java"));
  assert.ok(readPaths.includes("modules/integration/src/main/java/demo/StubStorageGateway.java"));
});

test("required semantic candidates do not evict non-LSP read plan neighbors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-readplan-protect-"));
  await mkdir(path.join(root, "modules", "integration", "src", "main", "java", "demo"), { recursive: true });
  await mkdir(path.join(root, "modules", "report", "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(root, "modules", "integration", "src", "main", "java", "demo", "StorageGateway.java"), [
    "package demo;",
    "public interface StorageGateway {",
    "  StorageSignedUrlResult getSignedUrl(StorageSignedUrlCommand command);",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(root, "modules", "integration", "src", "main", "java", "demo", "StorageSignedUrlCommand.java"), "package demo; public record StorageSignedUrlCommand(String key) {}\n");
  await writeFile(path.join(root, "modules", "integration", "src", "main", "java", "demo", "StorageSignedUrlResult.java"), "package demo; public record StorageSignedUrlResult(String url) {}\n");
  await writeFile(path.join(root, "modules", "integration", "src", "main", "java", "demo", "AliyunOssGateway.java"), "package demo; public class AliyunOssGateway implements StorageGateway { public StorageSignedUrlResult getSignedUrl(StorageSignedUrlCommand command) { return null; } }\n");
  await writeFile(path.join(root, "modules", "integration", "src", "main", "java", "demo", "StubStorageGateway.java"), "package demo; public class StubStorageGateway implements StorageGateway { public StorageSignedUrlResult getSignedUrl(StorageSignedUrlCommand command) { return null; } }\n");
  const referenceItems = [];
  const implementationItems = [];
  for (let index = 0; index < 8; index += 1) {
    const caller = path.join(root, "modules", "report", "src", "main", "java", "demo", `ReportStorageCaller${index}.java`);
    await writeFile(caller, `package demo; public class ReportStorageCaller${index} { public void call() {} }\n`);
    const location = {
      uri: pathToFileURL(caller).toString(),
      range: { start: { line: 0, character: 27 }, end: { line: 0, character: 47 } }
    };
    referenceItems.push(location);
    implementationItems.push(location);
  }
  const session = new FakeSemanticSession(referenceItems, [], implementationItems);

  const result = await new AgentRouter(root, session as unknown as JdtlsSession, new SourceIndex(root)).impact(options({
    anchors: [{ file: "modules/integration/src/main/java/demo/StorageGateway.java", line: 3, column: 28 }],
    profile: "port",
    semanticPolicy: "required",
    readPlanMaxItems: 6,
    focusModules: ["integration"],
    taskKeywords: ["storage", "signed", "url", "report"]
  }));
  const readPaths = readPlanPaths(result);

  assert.equal(session.referencesCalls, 1);
  assert.ok(readPaths.includes("modules/integration/src/main/java/demo/StorageGateway.java"));
  assert.ok(readPaths.includes("modules/integration/src/main/java/demo/StorageSignedUrlCommand.java"));
  assert.ok(readPaths.includes("modules/integration/src/main/java/demo/StorageSignedUrlResult.java"));
  assert.ok(readPaths.some(file => file.endsWith("AliyunOssGateway.java") || file.endsWith("StubStorageGateway.java")));
});

test("required semantic verify persists reference edges for cold reuse", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-edge-writeback-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  const anchor = path.join(root, "src", "main", "java", "demo", "FooService.java");
  await writeFile(anchor, "package demo;\npublic class FooService { public void applyOrder() {} }\n");
  const caller = path.join(root, "src", "main", "java", "demo", "OtherController.java");
  await writeFile(caller, "package demo;\npublic class OtherController { public void route() {} }\n");
  const session = new FakeSemanticSession([
    { uri: pathToFileURL(caller).toString(), range: { start: { line: 1, character: 13 }, end: { line: 1, character: 28 } } }
  ]);

  await new AgentRouter(root, session as unknown as JdtlsSession, new SourceIndex(root)).impact(options({
    anchors: [{ file: "src/main/java/demo/FooService.java", line: 2, column: 45 }],
    profile: "service",
    semanticPolicy: "required"
  }));

  const edges = new EdgeStore(root).edgesFor(anchor);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].to, caller);
  assert.equal(edges[0].kind, "reference");
});

test("failed semantic verify does not persist edges", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-edge-writeback-fail-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  const anchor = path.join(root, "src", "main", "java", "demo", "FooService.java");
  await writeFile(anchor, "package demo;\npublic class FooService { public void applyOrder() {} }\n");
  const session = new FakeSemanticSession();
  session.failReferences = true;

  await new AgentRouter(root, session as unknown as JdtlsSession, new SourceIndex(root)).impact(options({
    anchors: [{ file: "src/main/java/demo/FooService.java", line: 2, column: 45 }],
    profile: "service",
    semanticPolicy: "required"
  }));

  assert.deepEqual(new EdgeStore(root).edgesFor(anchor), []);
});

test("persisted semantic edges provide high-confidence candidates without lsp", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-persisted-recall-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  const anchor = path.join(root, "src", "main", "java", "demo", "FooService.java");
  await writeFile(anchor, "package demo;\npublic class FooService { public void applyOrder() {} }\n");
  const caller = path.join(root, "src", "main", "java", "demo", "OtherController.java");
  await writeFile(caller, "package demo;\npublic class OtherController { public void route() {} }\n");
  new EdgeStore(root).recordEdges(anchor, [
    { to: caller, kind: "reference", line: 2, column: 14 },
    { to: caller, kind: "reference", line: 2, column: 30 }
  ]);
  const session = new FakeSemanticSession();

  const result = await new AgentRouter(root, session as unknown as JdtlsSession, new SourceIndex(root)).impact(options({
    anchors: [{ file: "src/main/java/demo/FooService.java", line: 2, column: 45 }],
    profile: "service",
    semanticPolicy: "fast",
    verbosity: "diagnostic"
  }));

  const persisted = result.files.find(file => String(file.path).endsWith("OtherController.java")) as Record<string, unknown> | undefined;
  assert.equal(session.referencesCalls, 0);
  assert.equal(persisted?.confidence, "high");
  assert.ok((persisted?.verifiedBy as string[]).includes("persisted-reference"));
  assert.equal((result.metrics.persistedSemantic as { addedCandidates: number }).addedCandidates, 1);
});

test("stale persisted edges are ignored after anchor changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-persisted-stale-"));
  await mkdir(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  const anchor = path.join(root, "src", "main", "java", "demo", "FooService.java");
  await writeFile(anchor, "package demo;\npublic class FooService { public void applyOrder() {} }\n");
  const caller = path.join(root, "src", "main", "java", "demo", "OtherController.java");
  await writeFile(caller, "package demo;\npublic class OtherController { public void route() {} }\n");
  new EdgeStore(root).recordEdges(anchor, [{ to: caller, kind: "reference", line: 2, column: 14 }]);
  const future = new Date(Date.now() + 5000);
  utimesSync(anchor, future, future);

  const result = await new AgentRouter(root, new JdtlsSession(root), new SourceIndex(root)).impact(options({
    anchors: [{ file: "src/main/java/demo/FooService.java", line: 2, column: 45 }],
    profile: "service",
    semanticPolicy: "fast",
    verbosity: "diagnostic"
  }));

  assert.equal(result.files.some(file => ((file as Record<string, unknown>).verifiedBy as string[] | undefined)?.includes("persisted-reference")), false);
});

function readPlanPaths(result: Awaited<ReturnType<AgentRouter["impact"]>>): string[] {
  const byId = new Map(result.files.map(file => [String(file.id), String(file.path)]));
  return result.readPlan.map(item => byId.get(item.fileId)).filter((value): value is string => Boolean(value));
}

class FakeSemanticSession {
  referencesCalls = 0;
  typeHierarchyCalls = 0;
  failReferences = false;

  constructor(
    private readonly referenceItems: Array<{ uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }> = [],
    private readonly typeHierarchyEdges: Array<{ depth: number; from: unknown; to: unknown }> = [],
    private readonly implementationItems: Array<{ uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }> = []
  ) {}

  cacheStatus(): { invalidations: number; entries: number; hits: number; misses: number } {
    return { invalidations: 0, entries: 0, hits: 0, misses: 0 };
  }

  status(): { started: boolean; progress: { active: number } } {
    return { started: true, progress: { active: 0 } };
  }

  async semanticLocations(): Promise<{ definitions: []; implementations: Array<{ uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }> }> {
    return { definitions: [], implementations: this.implementationItems };
  }

  async references(): Promise<{ items: Array<{ uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }>; totalReferences: number; truncated: boolean }> {
    this.referencesCalls += 1;
    if (this.failReferences) {
      throw new Error("Timed out waiting for textDocument/references after 1ms");
    }
    return { items: this.referenceItems, totalReferences: this.referenceItems.length, truncated: false };
  }

  async typeHierarchy(): Promise<{ roots: []; edges: Array<{ depth: number; from: unknown; to: unknown }>; truncated: boolean }> {
    this.typeHierarchyCalls += 1;
    return { roots: [], edges: this.typeHierarchyEdges, truncated: false };
  }
}
