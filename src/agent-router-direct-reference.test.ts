import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRouter } from "./agent-router/index.js";
import type { ImpactOptions } from "./agent-types.js";
import { JdtlsSession } from "./jdtls-session.js";
import { SourceIndex } from "./source-index.js";

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

test("direct type references survive noisy cross-module tail truncation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-direct-reference-"));
  const appDir = path.join(root, "modules", "app", "src", "main", "java", "demo", "app");
  const dataDir = path.join(root, "modules", "data", "src", "main", "java", "demo", "data");
  const noiseDir = path.join(root, "modules", "noise", "src", "main", "java", "demo", "noise");
  await mkdir(appDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(noiseDir, { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(appDir, "ApplyInfoServiceImpl.java"), [
    "package demo.app;",
    "import demo.data.*;",
    ...Array.from({ length: 40 }, (_, index) => `import demo.noise.Noise${String(index).padStart(2, "0")};`),
    "public class ApplyInfoServiceImpl {",
    "  private CriticalRepository criticalRepository;",
    "  public void saveApplyBasicInfo() {",
    "    criticalRepository.save();",
    "  }",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(dataDir, "CriticalRepository.java"), "package demo.data;\npublic interface CriticalRepository { void save(); }\n");
  for (let index = 0; index < 40; index += 1) {
    const typeName = `Noise${String(index).padStart(2, "0")}`;
    await writeFile(path.join(noiseDir, `${typeName}.java`), `package demo.noise;\npublic class ${typeName} {}\n`);
  }

  const result = await new AgentRouter(root, new JdtlsSession(root), new SourceIndex(root)).impact(options({
    anchors: [{ file: "modules/app/src/main/java/demo/app/ApplyInfoServiceImpl.java", line: 44, column: 15 }],
    profile: "service",
    focusModules: ["app"],
    taskKeywords: ["apply", "info", "save"],
    readPlanMaxItems: 1,
    verbosity: "diagnostic"
  }));

  const repository = result.files.find(file => String(file.path).endsWith("CriticalRepository.java"));
  assert.equal(Array.isArray(repository?.verifiedBy) && repository.verifiedBy.includes("typeReference"), true);
});

test("method receiver relations outrank noisy class fields", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-method-relation-"));
  const appDir = path.join(root, "modules", "app", "src", "main", "java", "demo", "app");
  const dataDir = path.join(root, "modules", "data", "src", "main", "java", "demo", "data");
  const noiseDir = path.join(root, "modules", "noise", "src", "main", "java", "demo", "noise");
  await mkdir(appDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(noiseDir, { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(appDir, "ApplyInfoServiceImpl.java"), [
    "package demo.app;",
    "import demo.data.*;",
    "import demo.noise.*;",
    "public class ApplyInfoServiceImpl {",
    ...Array.from({ length: 28 }, (_, index) => `  private Noise${String(index).padStart(2, "0")} noise${index};`),
    "  private CriticalRepository criticalRepository;",
    "  public void saveApplyBasicInfo() {",
    "    criticalRepository.save();",
    "  }",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(dataDir, "CriticalRepository.java"), "package demo.data;\npublic interface CriticalRepository { void save(); }\n");
  for (let index = 0; index < 28; index += 1) {
    const typeName = `Noise${String(index).padStart(2, "0")}`;
    await writeFile(path.join(noiseDir, `${typeName}.java`), `package demo.noise;\npublic class ${typeName} {}\n`);
  }

  const result = await new AgentRouter(root, new JdtlsSession(root), new SourceIndex(root)).impact(options({
    anchors: [{ file: "modules/app/src/main/java/demo/app/ApplyInfoServiceImpl.java", line: 34, column: 15 }],
    profile: "service",
    focusModules: ["app"],
    taskKeywords: ["apply", "info", "save"],
    readPlanMaxItems: 1,
    verbosity: "diagnostic"
  }));

  const repository = result.files.find(file => String(file.path).endsWith("CriticalRepository.java"));
  assert.equal(Array.isArray(repository?.verifiedBy) && repository.verifiedBy.includes("typeReference"), true);
});

test("method parameter relations survive persistence score noise", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-method-relation-score-"));
  const appDir = path.join(root, "modules", "app", "src", "main", "java", "demo", "app");
  const dtoDir = path.join(root, "modules", "common", "src", "main", "java", "demo", "dto");
  const dataDir = path.join(root, "modules", "data", "src", "main", "java", "demo", "data");
  await mkdir(appDir, { recursive: true });
  await mkdir(dtoDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(appDir, "ApplyInfoServiceImpl.java"), [
    "package demo.app;",
    "import demo.dto.*;",
    "import demo.data.*;",
    "public class ApplyInfoServiceImpl {",
    ...Array.from({ length: 24 }, (_, index) => `  private Noise${String(index).padStart(2, "0")}Repository noise${index};`),
    "  public ApplyInfo saveApplyBasicInfo(ApplyInfoUpdateDTO command) {",
    "    return new ApplyInfo();",
    "  }",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(dtoDir, "ApplyInfoUpdateDTO.java"), "package demo.dto;\npublic record ApplyInfoUpdateDTO() {}\n");
  await writeFile(path.join(dataDir, "ApplyInfo.java"), "package demo.data;\npublic class ApplyInfo {}\n");
  for (let index = 0; index < 24; index += 1) {
    const typeName = `Noise${String(index).padStart(2, "0")}Repository`;
    await writeFile(path.join(dataDir, `${typeName}.java`), `package demo.data;\npublic interface ${typeName} {}\n`);
  }

  const result = await new AgentRouter(root, new JdtlsSession(root), new SourceIndex(root)).impact(options({
    anchors: [{ file: "modules/app/src/main/java/demo/app/ApplyInfoServiceImpl.java", line: 29, column: 20 }],
    profile: "service",
    focusModules: ["app"],
    taskKeywords: ["apply", "info", "save"],
    verbosity: "diagnostic"
  }));

  const dto = result.files.find(file => String(file.path).endsWith("ApplyInfoUpdateDTO.java"));
  assert.equal(Array.isArray(dto?.verifiedBy) && dto.verifiedBy.includes("typeReference"), true);
  assert.equal(Array.isArray(dto?.scoreBreakdown) && dto.scoreBreakdown.some(item => item.id === "finalize.method-relation" && item.delta > 0), true);
});
