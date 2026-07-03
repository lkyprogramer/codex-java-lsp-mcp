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
