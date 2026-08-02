// input: fixtures/framework-mapstruct - a real, checked-in MapStruct-flavored fixture repo (indexed
//         by a real worker, never hand-assembled facts).
// output: mapstructAdapter's isActive()/collect() behavior - source/target evidence from method
//         parameters and return types, and the @MappingTarget parameter special case.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedAnchor } from "../../agent-types.js";
import { RouterJavaIndex } from "../../java-index/router-java-index.js";
import { DeadlineBudget } from "../../runtime/deadline-budget.js";
import type { FrameworkAdapterContext } from "./adapter.js";
import type { FrameworkIndexView } from "../../java-index/framework-index-view.js";
import type { CandidateEvidence, EvidenceSignal } from "../evidence.js";
import { runFrameworkAdapters } from "./runner.js";
import { mapstructAdapter } from "./mapstruct-adapter.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, "..", "..", "..", "fixtures", "framework-mapstruct");

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for condition after ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function readyRouterAt(root: string): Promise<RouterJavaIndex> {
  const cacheDir = mkdtempSync(path.join(tmpdir(), "mapstruct-fixture-cache-"));
  const router = RouterJavaIndex.create(root, cacheDir);
  await router.open(1);
  await router.reconcile(1);
  await waitFor(async () => (await router.status()).pendingBackground === 0, 15_000);
  return router;
}

async function readyRouter(): Promise<RouterJavaIndex> {
  return readyRouterAt(repoRoot);
}

function file(relativePath: string): string {
  return path.join(repoRoot, relativePath);
}

function write(root: string, relativePath: string, content: string): void {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function anchor(absolutePath: string, overrides: Partial<ResolvedAnchor> = {}): ResolvedAnchor {
  return {
    id: "A1", absolutePath, line: 1, column: 1, profile: "service", symbolName: "Anchor", kind: "class",
    ...overrides
  };
}

async function frameworkContextFor(
  router: RouterJavaIndex,
  repo: string,
  anchors: readonly ResolvedAnchor[],
  candidateFiles: readonly string[]
): Promise<FrameworkAdapterContext> {
  return {
    repoRoot: repo,
    anchors,
    candidateFiles,
    staticEvidence: candidateFiles.map(candidate => ({
      file: candidate,
      signals: [],
      familyScores: { STATIC_STRUCTURE: 1 },
      finalScore: 1,
      confidence: "medium",
      degradation: []
    } satisfies CandidateEvidence)),
    frameworkIndex: router,
    generation: 1,
    budget: DeadlineBudget.fromTimeout(5_000)
  };
}

function signalsOf(evidence: readonly EvidenceSignal[], kind: string): EvidenceSignal[] {
  return evidence.filter(signal => signal.kind === kind);
}

test("isActive is true for the MapStruct fixture (pom.xml dependency marker)", async () => {
  const router = await readyRouter();
  try {
    const context = await frameworkContextFor(router, repoRoot, [anchor(file("src/main/java/demo/OrderMapper.java"))], []);
    assert.equal(await mapstructAdapter.isActive(context), true);
  } finally {
    await router.close();
  }
});

test("isActive is false for a fully-indexed repo with no MapStruct build marker or Java facts", async () => {
  const plainRoot = mkdtempSync(path.join(tmpdir(), "mapstruct-inactive-repo-"));
  write(plainRoot, "src/main/java/demo/Plain.java", "package demo;\nclass Plain {}\n");
  write(plainRoot, "pom.xml", "<project><artifactId>plain</artifactId></project>");
  const router = await readyRouterAt(plainRoot);
  try {
    const context = await frameworkContextFor(router, plainRoot, [anchor(path.join(plainRoot, "src/main/java/demo/Plain.java"))], []);
    assert.equal(await mapstructAdapter.isActive(context), false);
  } finally {
    await router.close();
  }
});

test("isActive detects a MapStruct import from bounded request facts without scanning the whole index", async () => {
  let globalScanCalls = 0;
  const mapper = "/repo/src/main/java/demo/OrderMapper.java";
  const context: FrameworkAdapterContext = {
    repoRoot: "/repo",
    anchors: [anchor("/repo/src/main/java/demo/Controller.java")],
    candidateFiles: [mapper],
    staticEvidence: [{
      file: mapper,
      signals: [{ family: "STATIC_STRUCTURE" } as EvidenceSignal],
      familyScores: {},
      finalScore: 0,
      confidence: "medium",
      degradation: []
    }],
    frameworkIndex: {
      repositoryMarkers: async () => new Map(),
      frameworkFactsForFiles: async () => [{
        relativePath: "src/main/java/demo/OrderMapper.java",
        module: "",
        sourceSet: "main",
        packageName: "demo",
        imports: [{ qualifiedName: "org.mapstruct.Mapper", wildcard: false, static: false }],
        types: [], methods: [], fields: [], missingIds: [], truncated: false, coverage: "COMPLETE"
      }],
      frameworkStatus: async () => ({ coverage: "complete" }),
      repositoryFactMarkers: async () => {
        globalScanCalls += 1;
        return { importPrefixFound: false, annotationPrefixFound: false };
      }
    } as unknown as FrameworkIndexView,
    generation: 1,
    budget: DeadlineBudget.fromTimeout(5_000)
  };

  assert.equal(await mapstructAdapter.isActive(context), true);
  assert.equal(globalScanCalls, 0, "a non-MapStruct request must not pay a whole-store marker scan");
});

test("collect links OrderMapper.toResponse's parameter as SOURCE and its return type as TARGET", async () => {
  const router = await readyRouter();
  try {
    const orderMapperFile = file("src/main/java/demo/OrderMapper.java");
    const orderEntityFile = file("src/main/java/demo/OrderEntity.java");
    const orderResponseFile = file("src/main/java/demo/OrderResponse.java");
    const context = await frameworkContextFor(router, repoRoot, [anchor(orderMapperFile)], [orderMapperFile]);

    const result = await runFrameworkAdapters([mapstructAdapter], context);

    assert.equal(result.outcome.completion, "COMPLETE");
    const source = signalsOf(result.outcome.evidence, "MAPSTRUCT_SOURCE");
    assert.ok(source.some(s => s.candidateFile === orderEntityFile && s.sourceFile === orderMapperFile));

    const target = signalsOf(result.outcome.evidence, "MAPSTRUCT_TARGET");
    assert.ok(target.some(s => s.candidateFile === orderResponseFile), "toResponse's return type is a target");

    const candidatePaths = new Set(result.outcome.candidates.map(candidate => candidate.absolutePath));
    assert.ok(candidatePaths.has(orderEntityFile));
    assert.ok(candidatePaths.has(orderResponseFile));
  } finally {
    await router.close();
  }
});

test("collect links @Mapper(uses = AddressMapper.class) to the used mapper via the same-package fallback (no import needed)", async () => {
  const router = await readyRouter();
  try {
    const orderMapperFile = file("src/main/java/demo/OrderMapper.java");
    const addressMapperFile = file("src/main/java/demo/AddressMapper.java");
    const context = await frameworkContextFor(router, repoRoot, [anchor(orderMapperFile)], [orderMapperFile]);

    const result = await runFrameworkAdapters([mapstructAdapter], context);

    const uses = signalsOf(result.outcome.evidence, "MAPSTRUCT_USES");
    assert.equal(uses.length, 1);
    assert.equal(uses[0]!.candidateFile, addressMapperFile);
    assert.equal(uses[0]!.sourceFile, orderMapperFile);
  } finally {
    await router.close();
  }
});

test("collect resolves an unqualified uses= class literal via an explicit cross-package import", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "mapstruct-uses-explicit-import-"));
  write(root, "pom.xml", "<project><dependencies><dependency><groupId>org.mapstruct</groupId></dependency></dependencies></project>");
  write(root, "src/main/java/other/AddressMapper.java", "package other;\nimport org.mapstruct.Mapper;\n@Mapper\npublic interface AddressMapper {}\n");
  write(
    root,
    "src/main/java/demo/OrderMapper.java",
    "package demo;\nimport org.mapstruct.Mapper;\nimport other.AddressMapper;\n@Mapper(uses = AddressMapper.class)\ninterface OrderMapper {}\n"
  );
  const router = await readyRouterAt(root);
  try {
    const orderMapperFile = path.join(root, "src/main/java/demo/OrderMapper.java");
    const addressMapperFile = path.join(root, "src/main/java/other/AddressMapper.java");
    const context = await frameworkContextFor(router, root, [anchor(orderMapperFile)], [orderMapperFile]);

    const result = await runFrameworkAdapters([mapstructAdapter], context);

    const uses = signalsOf(result.outcome.evidence, "MAPSTRUCT_USES");
    assert.equal(uses.length, 1, "AddressMapper is in a different package - only its explicit import can resolve it, the same-package guess would be wrong");
    assert.equal(uses[0]!.candidateFile, addressMapperFile);
  } finally {
    await router.close();
  }
});

test("collect resolves multiple uses= class literals from a brace-list", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "mapstruct-uses-multiple-"));
  write(root, "pom.xml", "<project><dependencies><dependency><groupId>org.mapstruct</groupId></dependency></dependencies></project>");
  write(root, "src/main/java/demo/AddressMapper.java", "package demo;\nimport org.mapstruct.Mapper;\n@Mapper\ninterface AddressMapper {}\n");
  write(root, "src/main/java/demo/ContactMapper.java", "package demo;\nimport org.mapstruct.Mapper;\n@Mapper\ninterface ContactMapper {}\n");
  write(
    root,
    "src/main/java/demo/OrderMapper.java",
    "package demo;\nimport org.mapstruct.Mapper;\n@Mapper(uses = {AddressMapper.class, ContactMapper.class})\ninterface OrderMapper {}\n"
  );
  const router = await readyRouterAt(root);
  try {
    const orderMapperFile = path.join(root, "src/main/java/demo/OrderMapper.java");
    const context = await frameworkContextFor(router, root, [anchor(orderMapperFile)], [orderMapperFile]);

    const result = await runFrameworkAdapters([mapstructAdapter], context);

    const uses = signalsOf(result.outcome.evidence, "MAPSTRUCT_USES");
    assert.deepEqual(
      new Set(uses.map(s => path.basename(s.candidateFile))),
      new Set(["AddressMapper.java", "ContactMapper.java"])
    );
  } finally {
    await router.close();
  }
});

test("collect expands a structurally signaled mapper before family scores are materialized", async () => {
  const router = await readyRouter();
  try {
    const orderMapperFile = file("src/main/java/demo/OrderMapper.java");
    const addressMapperFile = file("src/main/java/demo/AddressMapper.java");
    const base = await frameworkContextFor(router, repoRoot, [anchor(file("src/main/java/demo/OrderService.java"))], [orderMapperFile]);
    const context: FrameworkAdapterContext = {
      ...base,
      staticEvidence: [{
        ...base.staticEvidence[0]!,
        familyScores: {},
        // The router invokes framework adapters before rankCandidates(), so
        // normalization has preserved the structural signal but has not yet
        // populated familyScores.
        signals: [{ family: "STATIC_STRUCTURE" } as EvidenceSignal]
      }]
    };

    const result = await runFrameworkAdapters([mapstructAdapter], context);

    assert.ok(
      signalsOf(result.outcome.evidence, "MAPSTRUCT_USES").some(signal => signal.candidateFile === addressMapperFile),
      "a static provider signal must seed the MapStruct traversal before family scoring"
    );
  } finally {
    await router.close();
  }
});

test("collect resolves a cross-module uses declaration before the background reconcile reaches its source root", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "mapstruct-cold-cross-module-"));
  write(root, "pom.xml", "<project><dependencies><dependency><groupId>org.mapstruct</groupId></dependency></dependencies></project>");
  write(root, "modules/common/src/main/java/common/IdConverter.java", "package common;\npublic class IdConverter {}\n");
  write(
    root,
    "modules/school/src/main/java/school/OrderMapper.java",
    "package school;\nimport org.mapstruct.Mapper;\nimport common.IdConverter;\n@Mapper(uses = IdConverter.class)\ninterface OrderMapper {}\n"
  );
  const cacheDir = mkdtempSync(path.join(tmpdir(), "mapstruct-cold-cross-module-cache-"));
  const router = RouterJavaIndex.create(root, cacheDir);
  await router.open(1);
  try {
    const mapper = path.join(root, "modules/school/src/main/java/school/OrderMapper.java");
    const result = await runFrameworkAdapters([mapstructAdapter], await frameworkContextFor(router, root, [anchor(mapper)], [mapper]));

    assert.ok(
      signalsOf(result.outcome.evidence, "MAPSTRUCT_USES").some(signal => signal.candidateFile.endsWith("modules/common/src/main/java/common/IdConverter.java")),
      "an explicit cross-module class literal must not wait for the background sweep to discover its conventional source path"
    );
  } finally {
    await router.close();
  }
});

test("collect limits a non-anchor mapper to mapping methods that touch the anchor type", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "mapstruct-anchor-scoped-"));
  write(root, "pom.xml", "<project><dependencies><dependency><groupId>org.mapstruct</groupId></dependency></dependencies></project>");
  write(root, "src/main/java/demo/Anchor.java", "package demo;\nclass Anchor {}\n");
  write(root, "src/main/java/demo/Other.java", "package demo;\nclass Other {}\n");
  write(root, "src/main/java/demo/Response.java", "package demo;\nclass Response {}\n");
  write(root, "src/main/java/demo/DelegateMapper.java", "package demo;\nclass DelegateMapper {}\n");
  write(
    root,
    "src/main/java/demo/OrderMapper.java",
    "package demo;\nimport org.mapstruct.Mapper;\nimport demo.DelegateMapper;\n@Mapper(uses = DelegateMapper.class)\ninterface OrderMapper { Response mapOther(Other value); Response mapAnchor(Anchor value); }\n"
  );
  const router = await readyRouterAt(root);
  try {
    const mapper = path.join(root, "src/main/java/demo/OrderMapper.java");
    const anchorFile = path.join(root, "src/main/java/demo/Anchor.java");
    const context = await frameworkContextFor(router, root, [anchor(anchorFile)], [anchorFile, mapper]);
    const result = await runFrameworkAdapters([mapstructAdapter], context);

    const source = signalsOf(result.outcome.evidence, "MAPSTRUCT_SOURCE");
    assert.equal(source.length, 1);
    assert.equal(path.basename(source[0]!.candidateFile), "Anchor.java");
    const target = signalsOf(result.outcome.evidence, "MAPSTRUCT_TARGET");
    assert.equal(target.length, 1, "only mapAnchor's return type is in the anchor-scoped mapping path");
    assert.equal(path.basename(target[0]!.candidateFile), "Response.java");
    assert.equal(signalsOf(result.outcome.evidence, "MAPSTRUCT_USES").length, 1, "uses remains valid for the structurally connected mapper");
  } finally {
    await router.close();
  }
});

test("collect ignores @Mapper config class literals that are not uses dependencies", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "mapstruct-config-not-uses-"));
  write(root, "pom.xml", "<project><dependencies><dependency><groupId>org.mapstruct</groupId></dependency></dependencies></project>");
  write(root, "src/main/java/demo/MapperConfig.java", "package demo;\nclass MapperConfig {}\n");
  write(
    root,
    "src/main/java/demo/OrderMapper.java",
    "package demo;\nimport org.mapstruct.Mapper;\n@Mapper(config = MapperConfig.class)\ninterface OrderMapper {}\n"
  );
  const router = await readyRouterAt(root);
  try {
    const orderMapperFile = path.join(root, "src/main/java/demo/OrderMapper.java");
    const context = await frameworkContextFor(router, root, [anchor(orderMapperFile)], [orderMapperFile]);

    const result = await runFrameworkAdapters([mapstructAdapter], context);

    assert.equal(
      signalsOf(result.outcome.evidence, "MAPSTRUCT_USES").length,
      0,
      "only @Mapper(uses = ...) may produce MAPSTRUCT_USES evidence"
    );
  } finally {
    await router.close();
  }
});

test("collect ignores @Mapper imports class literals that are not uses dependencies", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "mapstruct-imports-not-uses-"));
  write(root, "pom.xml", "<project><dependencies><dependency><groupId>org.mapstruct</groupId></dependency></dependencies></project>");
  write(root, "src/main/java/demo/MapperImport.java", "package demo;\nclass MapperImport {}\n");
  write(
    root,
    "src/main/java/demo/OrderMapper.java",
    "package demo;\nimport org.mapstruct.Mapper;\n@Mapper(imports = MapperImport.class)\ninterface OrderMapper {}\n"
  );
  const router = await readyRouterAt(root);
  try {
    const orderMapperFile = path.join(root, "src/main/java/demo/OrderMapper.java");
    const context = await frameworkContextFor(router, root, [anchor(orderMapperFile)], [orderMapperFile]);

    const result = await runFrameworkAdapters([mapstructAdapter], context);

    assert.equal(
      signalsOf(result.outcome.evidence, "MAPSTRUCT_USES").length,
      0,
      "only @Mapper(uses = ...) may produce MAPSTRUCT_USES evidence"
    );
  } finally {
    await router.close();
  }
});

test("collect treats a @MappingTarget parameter as TARGET, not SOURCE, on a void update method", async () => {
  const router = await readyRouter();
  try {
    const orderMapperFile = file("src/main/java/demo/OrderMapper.java");
    const orderResponseFile = file("src/main/java/demo/OrderResponse.java");
    const context = await frameworkContextFor(router, repoRoot, [anchor(orderMapperFile)], [orderMapperFile]);

    const result = await runFrameworkAdapters([mapstructAdapter], context);

    const target = signalsOf(result.outcome.evidence, "MAPSTRUCT_TARGET").filter(s => s.detail?.includes("updateResponse"));
    assert.equal(target.length, 1, "the @MappingTarget parameter on the void updateResponse method is the only target for that method");
    assert.equal(target[0]!.candidateFile, orderResponseFile);

    const source = signalsOf(result.outcome.evidence, "MAPSTRUCT_SOURCE").filter(s => s.detail?.includes("updateResponse"));
    assert.equal(source.length, 1, "updateResponse's non-@MappingTarget parameter (source) is still a SOURCE");
  } finally {
    await router.close();
  }
});
