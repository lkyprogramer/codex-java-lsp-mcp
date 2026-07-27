import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRouter } from "./agent-router/index.js";
import type { ImpactOptions } from "./agent-types.js";
import { JdtlsSession } from "./jdtls-session.js";
import { SourceIndex } from "./source-index.js";
import { wrapSourceIndex } from "./source-index-router-adapter.js";

type ImpactResult = Awaited<ReturnType<AgentRouter["impact"]>>;

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

function readPlanPaths(result: ImpactResult): string[] {
  const byId = new Map(result.files.map(file => [file.id, String(file.path)]));
  return result.readPlan.map(item => byId.get(item.fileId) || item.fileId);
}

test("referenced interface implementers are added when the interface is already a candidate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-router-implementation-lookup-"));
  const appDir = path.join(root, "exam-candidate", "src", "main", "java", "demo", "app");
  const positionDir = path.join(root, "exam-service", "exam-service-candidate", "src", "main", "java", "demo", "position");
  const dtoDir = path.join(root, "exam-common", "src", "main", "java", "demo", "dto");
  await mkdir(appDir, { recursive: true });
  await mkdir(positionDir, { recursive: true });
  await mkdir(dtoDir, { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project><packaging>pom</packaging><modules><module>exam-candidate</module><module>exam-service/exam-service-candidate</module><module>exam-common</module></modules></project>\n");
  await writeFile(path.join(appDir, "CandidatePositionQueryService.java"), [
    "package demo.app;",
    "import demo.position.PositionService;",
    "import demo.dto.*;",
    "public class CandidatePositionQueryService {",
    "  private PositionService positionService;",
    "  private PositionPageDTO page;",
    ...Array.from({ length: 18 }, (_, index) => `  private Alpha${String(index).padStart(2, "0")}DTO alpha${index};`),
    "  public void select() {",
    "    positionService.select();",
    "  }",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(positionDir, "PositionService.java"), [
    "package demo.position;",
    "public interface PositionService {",
    "  void select();",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(positionDir, "PositionServiceImpl.java"), [
    "package demo.position;",
    "public class PositionServiceImpl implements PositionService {",
    "  public void select() {}",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(dtoDir, "PositionPageDTO.java"), "package demo.dto;\npublic record PositionPageDTO() {}\n");
  for (let index = 0; index < 18; index += 1) {
    const typeName = `Alpha${String(index).padStart(2, "0")}DTO`;
    await writeFile(path.join(dtoDir, `${typeName}.java`), `package demo.dto;\npublic record ${typeName}() {}\n`);
  }

  const result = await new AgentRouter(root, new JdtlsSession(root), wrapSourceIndex(new SourceIndex(root))).impact(options({
    anchors: [{ file: "exam-candidate/src/main/java/demo/app/CandidatePositionQueryService.java", line: 5, column: 15 }],
    profile: "service",
    focusModules: ["exam-candidate", "exam-service-candidate"],
    taskKeywords: ["position", "select"],
    readPlanMaxItems: 4,
    semanticPolicy: "fast",
    verbosity: "diagnostic"
  }));

  const service = result.files.find(file => String(file.path).endsWith("PositionService.java"));
  const dto = result.files.find(file => String(file.path).endsWith("PositionPageDTO.java"));
  const implementation = result.files.find(file => String(file.path).endsWith("PositionServiceImpl.java"));
  const readPaths = readPlanPaths(result);
  assert.equal(Array.isArray(service?.verifiedBy) && service.verifiedBy.includes("importGraph"), true);
  assert.equal(Array.isArray(dto?.verifiedBy) && dto.verifiedBy.includes("typeReference"), true);
  assert.equal(Array.isArray(implementation?.verifiedBy) && implementation.verifiedBy.includes("typeGraph"), true);
  assert.equal(readPaths.includes("exam-service/exam-service-candidate/src/main/java/demo/position/PositionService.java"), true);
  assert.equal(readPaths.includes("exam-common/src/main/java/demo/dto/PositionPageDTO.java"), true);
});
