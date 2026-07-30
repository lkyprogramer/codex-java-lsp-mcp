import assert from "node:assert/strict";
import test from "node:test";
import { rankReferenceFiles, type ReferenceLocation, type RankReferenceFilesContext } from "./reference-ranking.js";

function ref(absolutePath: string, line: number, overrides: Partial<ReferenceLocation> = {}): ReferenceLocation {
  return { absolutePath, line, column: 1, ...overrides };
}

function context(overrides: Partial<RankReferenceFilesContext> = {}): RankReferenceFilesContext {
  return {
    anchorModule: undefined,
    focusModules: [],
    taskKeywords: [],
    testReadMode: "defer",
    limitFiles: 20,
    ...overrides
  };
}

test("reference ranking selects valuable files before truncation", () => {
  const refs: ReferenceLocation[] = [
    ...Array.from({ length: 40 }, (_, i) => ref(`/repo/module-x/src/test/java/T${i}.java`, 1, { module: "module-x", sourceSet: "test" })),
    ref("/repo/module-a/src/main/java/demo/OrderService.java", 80, { module: "module-a", sourceSet: "main" })
  ];
  const ranked = rankReferenceFiles(refs, context({ anchorModule: "module-a", taskKeywords: ["order"], limitFiles: 20 }));
  assert.ok(ranked.some(item => item.path.endsWith("OrderService.java")));
  assert.equal(ranked[0]!.path.endsWith("OrderService.java"), true, "the single high-value candidate must sort first, not merely survive");
});

test("collapse accumulates totalReferences and every raw position per file", () => {
  const refs: ReferenceLocation[] = [
    ref("/repo/module-a/src/main/java/demo/Widget.java", 10, { module: "module-a", sourceSet: "main" }),
    ref("/repo/module-a/src/main/java/demo/Widget.java", 20, { module: "module-a", sourceSet: "main" }),
    ref("/repo/module-a/src/main/java/demo/Widget.java", 30, { module: "module-a", sourceSet: "main" })
  ];
  const ranked = rankReferenceFiles(refs, context());
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]!.totalReferences, 3);
  assert.deepEqual(ranked[0]!.positions.map(position => position.line), [10, 20, 30]);
});

test("value formula rewards main source, same module, focus module, task keyword, and framework role", () => {
  const plain = ref("/repo/module-b/src/main/java/demo/Plain.java", 1, { module: "module-b", sourceSet: "main" });
  const mainSource = ref("/repo/module-b/src/main/java/demo/MainSource.java", 1, { module: "module-b", sourceSet: "main" });
  const test_ = ref("/repo/module-b/src/test/java/demo/PlainTest.java", 1, { module: "module-b", sourceSet: "test" });
  const sameModule = ref("/repo/module-a/src/main/java/demo/SameModule.java", 1, { module: "module-a", sourceSet: "main" });
  const focusModule = ref("/repo/module-c/src/main/java/demo/FocusModule.java", 1, { module: "module-c", sourceSet: "main" });
  const taskKeyword = ref("/repo/module-b/src/main/java/demo/OrderThing.java", 1, { module: "module-b", sourceSet: "main" });
  const frameworkRole = ref("/repo/module-b/src/main/java/demo/WidgetController.java", 1, { module: "module-b", sourceSet: "main" });

  const ctx = context({ anchorModule: "module-a", focusModules: ["module-c"], taskKeywords: ["order"], limitFiles: 10 });
  const byPath = new Map(rankReferenceFiles([plain, mainSource, test_, sameModule, focusModule, taskKeyword, frameworkRole], ctx)
    .map(file => [file.path, file.valueScore]));

  const plainScore = byPath.get(plain.absolutePath)!;
  assert.ok(byPath.get(sameModule.absolutePath)! - plainScore >= 29, "same-module value must be near the full +30 bonus");
  assert.ok(byPath.get(focusModule.absolutePath)! - plainScore >= 24, "focus-module value must be near the full +25 bonus");
  assert.ok(byPath.get(taskKeyword.absolutePath)! - plainScore >= 19, "task-keyword value must be near the full +20 bonus");
  assert.ok(byPath.get(frameworkRole.absolutePath)! - plainScore >= 19, "framework-main-role value must be near the full +20 bonus");
  assert.ok(byPath.get(test_.absolutePath)! < plainScore, "a deferred test must score below an equivalent main-source file");
});

test("reference count is capped and cannot dominate structural value", () => {
  const popularLowValue = Array.from({ length: 400 }, (_, i) =>
    ref("/repo/module-x/src/test/java/Popular.java", i + 1, { module: "module-x", sourceSet: "test" }));
  const oneStructural = ref("/repo/module-a/src/main/java/demo/Structural.java", 1, { module: "module-a", sourceSet: "main" });

  const ranked = rankReferenceFiles([...popularLowValue, oneStructural], context({ anchorModule: "module-a", limitFiles: 10 }));
  assert.equal(ranked[0]!.path, oneStructural.absolutePath, "400 low-value test references must not outrank one same-module main-source file");
});

test("generated code is penalized relative to an otherwise identical hand-written file", () => {
  const handWritten = ref("/repo/module-a/src/main/java/demo/Widget.java", 1, { module: "module-a", sourceSet: "main" });
  const generated = ref("/repo/module-a/target/generated-sources/annotations/demo/WidgetMapperImpl.java", 1, { module: "module-a", sourceSet: "main" });

  const ranked = rankReferenceFiles([handWritten, generated], context());
  const byPath = new Map(ranked.map(file => [file.path, file.valueScore]));
  assert.ok(byPath.get(handWritten.absolutePath)! > byPath.get(generated.absolutePath)!);
});

test("limitFiles truncates the ranked result to the requested budget", () => {
  const refs = Array.from({ length: 30 }, (_, i) =>
    ref(`/repo/module-a/src/main/java/demo/File${i}.java`, 1, { module: "module-a", sourceSet: "main" }));
  const ranked = rankReferenceFiles(refs, context({ limitFiles: 5 }));
  assert.equal(ranked.length, 5);
});

test("ties break by higher reference count, then lexical path order", () => {
  const alpha = [
    ref("/repo/module-a/src/main/java/demo/Alpha.java", 1, { module: "module-a", sourceSet: "main" }),
    ref("/repo/module-a/src/main/java/demo/Alpha.java", 2, { module: "module-a", sourceSet: "main" })
  ];
  const beta = [ref("/repo/module-a/src/main/java/demo/Beta.java", 1, { module: "module-a", sourceSet: "main" })];
  const gamma = [ref("/repo/module-a/src/main/java/demo/Gamma.java", 1, { module: "module-a", sourceSet: "main" })];

  const ranked = rankReferenceFiles([...beta, ...gamma, ...alpha], context());
  assert.deepEqual(ranked.map(file => file.path), [
    "/repo/module-a/src/main/java/demo/Alpha.java",
    "/repo/module-a/src/main/java/demo/Beta.java",
    "/repo/module-a/src/main/java/demo/Gamma.java"
  ]);
});
