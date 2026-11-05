import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJavaParserBackend, type JavaSyntaxNode } from "./java-parser-backend.js";
import { extractJavaFile, type ExtractJavaInput } from "./ast-extractor.js";
import { javaMethodId } from "./stable-id.js";

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

test("array parameter signatures count type-side brackets exactly once", async () => {
  const backend = await createJavaParserBackend();
  const content = "package demo; class Arrays { void consume(String[] values) {} }";
  const result = extractJavaFile(baseInput({ content, relativePath: "src/main/java/demo/Arrays.java" }), backend);
  const method = result.methods[0]!;

  assert.equal(result.file.parseState, "COMPLETE");
  assert.equal(method.parameters[0]!.type.text, "String[]");
  assert.equal(method.parameters[0]!.type.arrayDepth, 1);
  assert.equal(method.signatureKey, "consume(String[])");
});

test("array parameter dimensions include declarator brackets and mixed bracket positions", async () => {
  const backend = await createJavaParserBackend();
  const declarations = [
    { parameter: "String[] values", text: "String[]", depth: 1 },
    { parameter: "String values[]", text: "String", depth: 1 },
    { parameter: "String[][] values", text: "String[][]", depth: 2 },
    { parameter: "String values[][]", text: "String", depth: 2 },
    { parameter: "String[] values[]", text: "String[]", depth: 2 },
    { parameter: "String[][] values[]", text: "String[][]", depth: 3 }
  ];
  const methods = declarations.map(({ parameter }, index) => `void consume${index}(${parameter}) {}`).join("\n");
  const content = `package demo; class Arrays {\n${methods}\n}`;
  const result = extractJavaFile(baseInput({ content, relativePath: "src/main/java/demo/Arrays.java" }), backend);

  assert.equal(result.file.parseState, "COMPLETE");
  declarations.forEach(({ parameter, text, depth }, index) => {
    const method = result.methods.find(candidate => candidate.name === `consume${index}`)!;
    const type = method.parameters[0]!.type;
    assert.equal(type.text, text, parameter);
    assert.equal(type.simpleName, "String", parameter);
    assert.equal(type.arrayDepth, depth, parameter);
    assert.equal(method.signatureKey, `consume${index}(String${"[]".repeat(depth)})`, parameter);
  });
});

test("varargs parameter signatures include the spread dimension and ignore declaration annotations", async () => {
  const backend = await createJavaParserBackend();
  const content = [
    "package demo;",
    "class Arrays {",
    "  void plain(String... values) {}",
    "  void annotated(@NonNull String... values) {}",
    "  void nested(String[]... values) {}",
    "  void annotatedNested(@NonNull String[]... values) {}",
    "}"
  ].join("\n");
  const result = extractJavaFile(baseInput({ content, relativePath: "src/main/java/demo/Arrays.java" }), backend);

  assert.equal(result.file.parseState, "COMPLETE");
  for (const [name, text, depth, annotations] of [
    ["plain", "String", 1, []],
    ["annotated", "String", 1, ["NonNull"]],
    ["nested", "String[]", 2, []],
    ["annotatedNested", "String[]", 2, ["NonNull"]]
  ] as const) {
    const method = result.methods.find(candidate => candidate.name === name)!;
    const parameter = method.parameters[0]!;
    assert.equal(parameter.name, "values", name);
    assert.equal(parameter.varargs, true, name);
    assert.equal(parameter.type.text, text, name);
    assert.equal(parameter.type.simpleName, "String", name);
    assert.equal(parameter.type.arrayDepth, depth, name);
    assert.deepEqual(parameter.annotations.map(annotation => annotation.name), [...annotations], name);
    assert.equal(method.signatureKey, `${name}(String${"[]".repeat(depth)})`, name);
  }
});

test("scalar and declarator-array overloads have distinct method IDs with equivalent array spellings", async () => {
  const backend = await createJavaParserBackend();
  const extract = (arrayParameter: string) => extractJavaFile(baseInput({
    content: `package demo; class Arrays { void f(String value) {} void f(${arrayParameter}) {} }`,
    relativePath: "src/main/java/demo/Arrays.java"
  }), backend);
  const declaratorArray = extract("String values[]");
  const typeArray = extract("String[] values");

  assert.equal(declaratorArray.file.parseState, "COMPLETE");
  assert.equal(typeArray.file.parseState, "COMPLETE");
  assert.deepEqual(declaratorArray.methods.map(method => method.signatureKey), ["f(String)", "f(String[])"]);
  assert.equal(new Set(declaratorArray.methods.map(method => method.methodId)).size, 2);
  assert.deepEqual(
    declaratorArray.methods.map(method => method.methodId),
    typeArray.methods.map(method => method.methodId)
  );
});

test("array signatures ignore bracket text inside dimension annotations and comments", async () => {
  const backend = await createJavaParserBackend();
  const extract = (parameter: string) => extractJavaFile(baseInput({
    content: `package demo; class Arrays { void f(${parameter}) {} void f(String[][] values) {} }`,
    relativePath: "src/main/java/demo/Arrays.java"
  }), backend);
  const baseline = extract("String[] values");

  assert.equal(baseline.file.parseState, "COMPLETE");
  for (const parameter of [
    'String values @A("[") []',
    "String[/*c*/] values",
    "String @A [] values"
  ]) {
    const result = extract(parameter);
    assert.equal(result.file.parseState, "COMPLETE", parameter);
    const arrayMethod = result.methods[0]!;
    const matrixMethod = result.methods[1]!;
    assert.equal(arrayMethod.parameters[0]!.type.arrayDepth, 1, parameter);
    assert.equal(arrayMethod.signatureKey, "f(String[])", parameter);
    assert.equal(arrayMethod.methodId, baseline.methods[0]!.methodId, parameter);
    assert.equal(matrixMethod.signatureKey, "f(String[][])", parameter);
    assert.notEqual(arrayMethod.methodId, matrixMethod.methodId, parameter);
  }
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

test("an unshadowed explicit type import is retained as the receiver of a static call", async () => {
  const backend = await createJavaParserBackend();
  const content = [
    "package demo;",
    "",
    "import tools.Converters;",
    "",
    "class StaticCaller {",
    "  void run() {",
    "    Converters.map();",
    "  }",
    "}",
    ""
  ].join("\n");
  const result = extractJavaFile(baseInput({ content, relativePath: "src/main/java/demo/StaticCaller.java" }), backend);
  const call = result.methods.find(method => method.name === "run")!.callSites.find(site => site.name === "map")!;

  assert.equal(call.receiverText, "Converters");
  assert.equal(call.receiverDeclaredType?.text, "Converters");
});

test("a value binding shadows an explicit import when extracting a call receiver", async () => {
  const backend = await createJavaParserBackend();
  const content = [
    "package demo;",
    "",
    "import tools.Converters;",
    "",
    "class ShadowedStaticCaller {",
    "  void run(Other Converters) {",
    "    Converters.map();",
    "  }",
    "}",
    ""
  ].join("\n");
  const result = extractJavaFile(baseInput({ content, relativePath: "src/main/java/demo/ShadowedStaticCaller.java" }), backend);
  const call = result.methods.find(method => method.name === "run")!.callSites.find(site => site.name === "map")!;

  assert.equal(call.receiverDeclaredType?.text, "Other");
});

test("local declarations have distinct source identities and own their method calls", async () => {
  const backend = await createJavaParserBackend();
  const content = [
    "package demo;",
    "class Outer {",
    "  static { class Initialized {} }",
    "  void first() {",
    "    String label = \"😀\"; class Local {",
    "      Local() {}",
    "      class Member {}",
    "      void inside() { innerCall(); }",
    "    }",
    "    outerCall();",
    "  }",
    "  void second() { class Local {} }",
    "}"
  ].join("\n");
  const result = extractJavaFile(baseInput({ content, relativePath: "src/main/java/demo/Outer.java" }), backend);
  const outer = result.types.find(type => type.simpleName === "Outer")!;
  const locals = result.types.filter(type => type.simpleName === "Local");
  assert.equal(result.file.parseState, "COMPLETE");
  assert.equal(locals.length, 2);
  assert.notEqual(locals[0]!.typeId, locals[1]!.typeId);
  assert.ok(locals.every(type => type.fqn === undefined && type.enclosingTypeId === outer.typeId));
  assert.ok(result.types.find(type => type.simpleName === "Initialized"));
  const member = result.types.find(type => type.simpleName === "Member")!;
  assert.equal(member.enclosingTypeId, locals[0]!.typeId);
  assert.equal(member.fqn, undefined);
  assert.equal(new Set(result.file.allTypeIds).size, result.types.length);
  assert.deepEqual(result.file.topLevelTypeIds, [outer.typeId]);
  const first = result.methods.find(method => method.name === "first")!;
  const inside = result.methods.find(method => method.name === "inside")!;
  assert.deepEqual(first.callSites.map(call => call.name), ["outerCall"]);
  assert.deepEqual(inside.callSites.map(call => call.name), ["innerCall"]);
  assert.equal(inside.ownerTypeId, locals[0]!.typeId);
  const ctor = result.methods.find(method => method.constructor)!;
  assert.equal(ctor.ownerTypeId, locals[0]!.typeId);
  assert.equal(ctor.signatureKey, "<init>()");
  assert.equal(ctor.methodId, javaMethodId(locals[0]!.typeId, "<init>()"));
  const start = lineColToIndex(content, locals[0]!.nameRange!.start);
  const end = lineColToIndex(content, locals[0]!.nameRange!.end);
  assert.equal(content.slice(start, end), "Local");
});

test("compact record constructors inherit canonical parameters and keep declaration ranges", async () => {
  const backend = await createJavaParserBackend();
  const content = [
    "package demo;",
    "record Entry(int value, String... labels) {",
    "  Entry { labels.clone(); }",
    "}"
  ].join("\n");
  const result = extractJavaFile(baseInput({ content, relativePath: "src/main/java/demo/Entry.java" }), backend);
  const entry = result.types[0]!;
  const ctor = result.methods[0]!;
  assert.equal(result.file.parseState, "COMPLETE");
  assert.equal(ctor.constructor, true);
  assert.equal(ctor.name, "Entry");
  assert.equal(ctor.ownerTypeId, entry.typeId);
  assert.deepEqual(entry.methodIds, [ctor.methodId]);
  assert.deepEqual(ctor.parameters.map(param => [param.name, param.type.text, param.varargs]), [
    ["value", "int", false], ["labels", "String", true]
  ]);
  assert.equal(ctor.parameters[1]!.type.arrayDepth, 1);
  assert.equal(ctor.returnType, undefined);
  assert.equal(ctor.signatureKey, "<init>(int,String[])");
  assert.equal(ctor.parameters[0]!.range.start.line, 2);
  assert.equal(ctor.range.start.line, 3);
  assert.equal(ctor.range.end.line, 3);
  assert.equal(content.slice(lineColToIndex(content, ctor.nameRange!.start), lineColToIndex(content, ctor.nameRange!.end)), "Entry");
  assert.equal(ctor.callSites[0]!.receiverDeclaredType?.arrayDepth, 1);
});

function lineColToIndex(text: string, position: { line: number; column: number }): number {
  const lines = text.split("\n");
  let index = 0;
  for (let i = 0; i < position.line - 1; i += 1) index += lines[i]!.length + 1;
  return index + (position.column - 1);
}

test("parseErrorCount counts every ERROR and MISSING node, including MISSING leaves and errors nested in recovered code", async () => {
  const backend = await createJavaParserBackend();
  const naive = (node: JavaSyntaxNode): number =>
    (node.type === "ERROR" || node.isMissing ? 1 : 0) + node.children.reduce((sum, child) => sum + naive(child), 0);
  const sources = [
    "package demo;\nclass A { void m() { int x = 1 } }\n",
    "package demo;\nclass A { void m() { call(1, 2; } int f = ; }\n",
    "package demo;\nclass A { void m() { if (x) { y(); } \n",
    "package demo;\nclass A { ){ int = ; class <> void n() {} }\n",
    "package demo;\nclass A { /** doc */ void m() {} }\n"
  ];
  let missing = 0;
  for (const content of sources) {
    const root = backend.parse(content).rootNode;
    const walk = (node: JavaSyntaxNode): void => { if (node.isMissing) missing++; node.children.forEach(walk); };
    walk(root);
    const facts = extractJavaFile(baseInput({ content, relativePath: "src/main/java/demo/A.java" }), backend);
    assert.equal(facts.file.parseErrorCount, Math.max(naive(root), root.hasError ? 1 : 0), content);
  }
  assert.ok(missing > 0, "the corpus exercises MISSING leaves");
});
