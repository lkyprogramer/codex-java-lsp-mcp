import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJavaParserBackend } from "./java-parser-backend.js";
import { extractJavaFile, type ExtractJavaInput } from "./ast-extractor.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(dirname, "..", "..", "fixtures", "java-index-v2");

function baseInput(overrides: Partial<ExtractJavaInput> & { content: string; relativePath: string }): ExtractJavaInput {
  return {
    repoRoot: fixturesRoot,
    absolutePath: path.join(fixturesRoot, overrides.relativePath),
    sourceRoot: "src/main/java",
    module: "demo-module",
    sourceSet: "main",
    size: Buffer.byteLength(overrides.content, "utf8"),
    mtimeMs: 0,
    contentHash: "test",
    generation: 1,
    ...overrides
  };
}

test("extractJavaFile extracts package, imports, types, methods and call sites", async () => {
  const backend = await createJavaParserBackend();
  const relativePath = "src/main/java/demo/ComplexJava.java";
  const content = readFileSync(path.join(fixturesRoot, relativePath), "utf8");
  const input = baseInput({ content, relativePath });

  const result = extractJavaFile(input, backend);

  assert.equal(result.file.packageName, "demo");
  assert.deepEqual(result.file.imports.map(i => i.qualifiedName), [
    "java.util.List",
    "java.util.Map",
    "java.util.Objects.requireNonNull"
  ]);
  assert.deepEqual(result.types.map(t => t.simpleName).sort(), [
    "Child", "ComplexJava", "Helper", "SecondTopLevel"
  ]);
  // The plan's Step 5 FQN convention (package.Outer$Inner) is load-bearing
  // for Task 21a's sibling-worktree snapshot seeding; a simpleName-only
  // assertion would not catch a silent divergence to e.g. "Outer.Inner".
  assert.deepEqual(result.types.map(t => t.fqn).sort(), [
    "demo.ComplexJava", "demo.ComplexJava$Child", "demo.ComplexJava$Helper", "demo.SecondTopLevel"
  ]);
  const complexJava = result.types.find(t => t.simpleName === "ComplexJava")!;
  const child = result.types.find(t => t.simpleName === "Child")!;
  assert.equal(child.enclosingTypeId, complexJava.typeId);
  assert.ok(result.methods.some(m => m.name === "packagePrivate"));
  assert.ok(result.methods.some(m => m.name === "packagePrivateToo"));
  assert.ok(result.methods.some(m => m.constructor && m.name === "ComplexJava"));
  assert.ok(result.methods.find(m => m.name === "packagePrivate")!.bodyRange);
  assert.deepEqual(
    result.methods.find(m => m.name === "packagePrivate")!.callSites.map(c => c.name).sort(),
    ["Helper", "save"]
  );
  assert.equal(result.file.parseState, "COMPLETE");

  // The method's end range must not be thrown off by the unmatched `{` inside
  // the string literal ("{ this is not a block }") or the text block's own
  // brace-shaped content. If the boundary were miscomputed at the first such
  // brace, the method's sliced text would end early and miss everything
  // after the string/text-block declarations.
  const method = result.methods.find(m => m.name === "packagePrivate")!;
  const methodText = content.slice(
    lineColToIndex(content, method.range.start),
    lineColToIndex(content, method.range.end)
  );
  assert.match(methodText, /Helper helper = new Helper\(\);/);
  assert.match(methodText, /return repository\.save\(command, helper\);/);
  assert.ok(methodText.trimEnd().endsWith("}"));
});

test("extractJavaFile marks RECOVERED when a top-level type survives a parse error", async () => {
  const backend = await createJavaParserBackend();
  const content = [
    "package demo;",
    "",
    "public class Broken {",
    "  void ok() {}",
    "  void trailing( {",
    "}"
  ].join("\n");
  const input = baseInput({ content, relativePath: "src/main/java/demo/Broken.java" });

  const result = extractJavaFile(input, backend);

  assert.equal(result.file.parseState, "RECOVERED");
  assert.ok(result.types.some(t => t.simpleName === "Broken"));
  assert.ok(result.file.parseErrorCount > 0);
});

test("extractJavaFile marks FAILED when no useful structural root can be obtained", async () => {
  const backend = await createJavaParserBackend();
  const content = "{{{ not java at all ]] ) )) &&&";
  const input = baseInput({ content, relativePath: "src/main/java/demo/Garbage.java" });

  const result = extractJavaFile(input, backend);

  assert.equal(result.file.parseState, "FAILED");
  assert.equal(result.types.length, 0);
  assert.ok(result.file.parseErrorCount > 0);
});

test("extracted ranges are exact across Chinese text and a surrogate-pair emoji preceding a token", async () => {
  const backend = await createJavaParserBackend();
  const content = [
    "package demo;",
    "",
    "public class Widget {",
    '  String comment = "中文注释 \u{1F389}"; void run() {}',
    "}",
    ""
  ].join("\n");
  const input = baseInput({ content, relativePath: "src/main/java/demo/Widget.java" });

  const result = extractJavaFile(input, backend);
  const method = result.methods.find(m => m.name === "run");
  assert.ok(method);

  const lineIndex = 3;
  const line = content.split("\n")[lineIndex]!;
  const expectedColumn = line.indexOf("void run") + 1;
  assert.equal(method!.range.start.line, lineIndex + 1);
  assert.equal(method!.range.start.column, expectedColumn);
});

test("extractJavaFile extracts parameter annotations, including on a varargs parameter", async () => {
  const backend = await createJavaParserBackend();
  const content = [
    "package demo;",
    "",
    "class ParamAnnotations {",
    "  ParamAnnotations(@Autowired @Qualifier(\"primary\") Service svc) {}",
    "  void handle(@RequestParam(value = \"id\") String id, @NonNull String... tags) {}",
    "}",
    ""
  ].join("\n");
  const input = baseInput({ content, relativePath: "src/main/java/demo/ParamAnnotations.java" });

  const result = extractJavaFile(input, backend);

  const ctor = result.methods.find(m => m.constructor)!;
  assert.deepEqual(ctor.parameters[0]!.annotations.map(a => a.name), ["Autowired", "Qualifier"]);

  const handle = result.methods.find(m => m.name === "handle")!;
  assert.equal(handle.parameters.length, 2);
  assert.deepEqual(handle.parameters[0]!.annotations.map(a => a.name), ["RequestParam"]);
  assert.match(handle.parameters[0]!.annotations[0]!.argumentsText ?? "", /value = "id"/);
  assert.equal(handle.parameters[1]!.varargs, true);
  assert.deepEqual(handle.parameters[1]!.annotations.map(a => a.name), ["NonNull"]);
});

test("a leading block comment in an argument list does not shift arity or argumentTypeHints out of position", async () => {
  const backend = await createJavaParserBackend();
  const content = [
    "package demo;",
    "",
    "class CommentedCall {",
    "  void handle(Order order) {",
    "    publish(/* note */ order);",
    "  }",
    "  void publish(Order o) {}",
    "}",
    ""
  ].join("\n");
  const input = baseInput({ content, relativePath: "src/main/java/demo/CommentedCall.java" });

  const result = extractJavaFile(input, backend);
  const publishCall = result.methods.find(m => m.name === "handle")!.callSites.find(c => c.name === "publish")!;

  assert.equal(publishCall.arity, 1, "the comment must not be counted as an argument");
  assert.equal(publishCall.argumentTypeHints.length, 1);
  assert.equal(publishCall.argumentTypeHints[0]!.simpleName, "Order");
});

test("extractJavaFile binds call-site arguments to their type where the syntax makes it unambiguous", async () => {
  const backend = await createJavaParserBackend();
  const content = [
    "package demo;",
    "",
    "class ArgHints {",
    "  private Publisher publisher;",
    "  void handle(Order order) {",
    "    Order local = order;",
    "    publisher.publishNew(new OrderCreated(order));",
    "    publisher.publishParam(order);",
    "    publisher.publishLocal(local);",
    "    publisher.publishField(publisher);",
    "    publisher.publishUnknown(order.toString());",
    "  }",
    "}",
    ""
  ].join("\n");
  const input = baseInput({ content, relativePath: "src/main/java/demo/ArgHints.java" });

  const result = extractJavaFile(input, backend);
  const handle = result.methods.find(m => m.name === "handle")!;
  const callSite = (name: string) => handle.callSites.find(c => c.name === name)!;

  // A direct `new T(...)` argument's type is read off the constructed type itself.
  assert.equal(callSite("publishNew").argumentTypeHints[0]!.simpleName, "OrderCreated");
  // An identifier already bound in scope as a parameter/local/field resolves
  // to that binding's declared type, not the constructed argument's type.
  assert.equal(callSite("publishParam").argumentTypeHints[0]!.simpleName, "Order");
  assert.equal(callSite("publishLocal").argumentTypeHints[0]!.simpleName, "Order");
  assert.equal(callSite("publishField").argumentTypeHints[0]!.simpleName, "Publisher");
  // A nested call's result type is not guessed - stays an UNRESOLVED placeholder.
  const unknownHint = callSite("publishUnknown").argumentTypeHints[0]!;
  assert.equal(unknownHint.simpleName, "");
  assert.equal(unknownHint.resolution.state, "UNRESOLVED");
  // Every call in this test has exactly one argument - alignment must hold even
  // for the unresolved case, not just the resolvable ones.
  for (const name of ["publishNew", "publishParam", "publishLocal", "publishField", "publishUnknown"]) {
    assert.equal(callSite(name).argumentTypeHints.length, callSite(name).arity);
  }
});

function lineColToIndex(text: string, position: { line: number; column: number }): number {
  const lines = text.split("\n");
  let index = 0;
  for (let i = 0; i < position.line - 1; i += 1) index += lines[i]!.length + 1;
  return index + (position.column - 1);
}
