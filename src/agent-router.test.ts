// input: Real lishuedu anchors with semanticPolicy=fast.
// output: Assertions for v5 routing, read budgets, test priority, and cross-module suppression metrics.
// pos: Node test coverage for the agent impact router.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
    private readonly typeHierarchyEdges: Array<{ depth: number; from: unknown; to: unknown }> = []
  ) {}

  cacheStatus(): { invalidations: number; entries: number; hits: number; misses: number } {
    return { invalidations: 0, entries: 0, hits: 0, misses: 0 };
  }

  status(): { started: boolean; progress: { active: number } } {
    return { started: true, progress: { active: 0 } };
  }

  async semanticLocations(): Promise<{ definitions: []; implementations: [] }> {
    return { definitions: [], implementations: [] };
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
