import assert from "node:assert/strict";
import test from "node:test";
import type { JavaTypeRef } from "../java-index/index-types.js";
import { isSymbolIdLike, parametersFit, selectorParameters } from "./symbol-target.js";

test("selectorParameters reduces a parameter list to erased names with array dimensions", () => {
  assert.equal(selectorParameters("com.example.Orders#place"), undefined, "no list: a plain name");
  assert.equal(selectorParameters("com.example.Orders"), undefined);
  assert.deepEqual(selectorParameters("com.example.Orders#ship()"), { name: "com.example.Orders#ship", parameters: [] });
  assert.deepEqual(selectorParameters(" Orders#place(int, java.lang.String) "), { name: "Orders#place", parameters: ["int", "java.lang.String"] });
  assert.deepEqual(selectorParameters("Orders#put(Map<String, List<Integer>> values, int n)")?.parameters, ["Map", "int"], "generics never split a list");
  assert.deepEqual(selectorParameters("Orders#log(@NotNull final String... lines)")?.parameters, ["String[]"], "annotations, modifiers and names drop; varargs is []");
  assert.deepEqual(selectorParameters("Orders#fill(byte [] data, @Named(\"x\") int[][] grid)")?.parameters, ["byte[]", "int[][]"]);
  assert.deepEqual(selectorParameters("Orders#tag(@Size(min = 1, max = 2) String a, @Named({\"a,b\", \")\"}) Outer$Inner b)")?.parameters,
    ["String", "Outer.Inner"], "annotation arguments hold commas, parentheses and strings; $ nesting reads as .");
});

const ref = (text: string, arrayDepth: number, resolution: JavaTypeRef["resolution"] = { state: "UNRESOLVED" }, extra: Partial<JavaTypeRef> = {}): JavaTypeRef => ({
  text, simpleName: text.split("<")[0]!.replace(/\[\s*\]/g, "").split(".").pop()!, typeArguments: [], arrayDepth, resolution,
  range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } }, ...extra
});
const method = (types: JavaTypeRef[], typeParameters: Array<{ name: string; bounds: JavaTypeRef[] }> = []) => ({
  ownerTypeId: "type:v2:A.java#demo.A",
  parameters: types.map((type, index) => ({ name: `p${index}`, type, varargs: false, annotations: [], range: type.range! })),
  typeParameters: typeParameters.map(parameter => ({ ...parameter, range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } }))
});
const fit = (types: JavaTypeRef[], selector: string, typeParameters?: Array<{ name: string; bounds: JavaTypeRef[] }>) =>
  parametersFit(method(types, typeParameters), selectorParameters(`A#f(${selector})`)!.parameters);

test("parametersFit compares array dimensions from the parsed facts, not the erased key spelling", () => {
  // The extractor keys "String[] a" as String[][] (dimensions counted twice) and "String... a" as String[].
  assert.equal(fit([ref("String[]", 1)], "String[]"), "yes");
  assert.equal(fit([ref("String[]", 1)], "String..."), "yes", "varargs and [] erase alike");
  assert.equal(fit([ref("String[]", 1)], "String[][]"), "no", "a different dimension count is another overload");
  assert.equal(fit([ref("String", 1)], "String[]"), "yes", "a varargs declaration");
  assert.equal(fit([ref("int[][]", 2)], "int[][]"), "yes");
  assert.equal(fit([ref("List<String>[]", 1)], "List<Integer>[]"), "yes");
  assert.equal(fit([ref("String", 0)], "String[]"), "no");
});

test("parametersFit qualifies names only as far as the facts prove", () => {
  const external = ref("String", 0, { state: "EXTERNAL", qualifiedName: "java.lang.String", strategy: "JAVA_LANG" });
  assert.equal(fit([external], "String"), "yes");
  assert.equal(fit([external], "java.lang.String"), "yes");
  assert.equal(fit([external], "com.other.String"), "no", "both sides qualified: no simple-name fallback");
  const repo = ref("Line", 0, { state: "RESOLVED_REPO", typeId: `type:v2:${encodeURIComponent("src/main/java/demo/Orders.java")}#demo.Orders.Line`, strategy: "SAME_PACKAGE" } as JavaTypeRef["resolution"]);
  assert.equal(fit([repo], "Orders.Line"), "yes");
  assert.equal(fit([repo], "Orders$Line"), "yes");
  assert.equal(fit([repo], "demo.Orders.Line"), "yes");
  assert.equal(fit([repo], "other.Line"), "no");
  assert.equal(fit([ref("Line", 0)], "demo.Line"), "maybe", "an unresolved simple source name cannot prove a qualifier");
  assert.equal(fit([ref("a.Line", 0)], "b.Line"), "no");
  assert.equal(fit([ref("int", 0)], "long"), "no");
  // "Map.Entry" under an import of Map resolves EXTERNAL/QUALIFIED with the source spelling, not a proven FQN.
  const partial = ref("Map.Entry<K, V>", 0, { state: "EXTERNAL", qualifiedName: "Map.Entry", strategy: "QUALIFIED" }, { qualifiedName: "Map.Entry" });
  assert.equal(fit([partial], "Map.Entry"), "yes");
  assert.equal(fit([partial], "Entry"), "yes");
  assert.equal(fit([partial], "java.util.Map.Entry"), "maybe", "never a false absence");
  assert.equal(fit([partial], "java.util.Map$Entry"), "maybe");
  assert.equal(fit([partial], "Other.Entry"), "no");
  const guessed = ref("Line", 0, { state: "RESOLVED_REPO", typeId: `type:v2:${encodeURIComponent("src/main/java/a/Line.java")}#a.Line`, strategy: "REPO_UNIQUE_SIMPLE_NAME" });
  assert.equal(fit([guessed], "a.Line"), "yes");
  assert.equal(fit([guessed], "b.Line"), "maybe", "a repo-unique pick is a guess, not proof");
});

test("parametersFit erases a type variable to its first bound", () => {
  const variable = (name: string) => ref(name, 0, { state: "TYPE_VARIABLE", name });
  assert.equal(fit([variable("T")], "T"), "yes");
  assert.equal(fit([variable("T")], "Object", [{ name: "T", bounds: [] }]), "yes");
  assert.equal(fit([variable("T")], "java.lang.Object", [{ name: "T", bounds: [] }]), "yes");
  const number = ref("Number", 0, { state: "EXTERNAL", qualifiedName: "java.lang.Number", strategy: "JAVA_LANG" });
  assert.equal(fit([variable("T")], "Number", [{ name: "T", bounds: [number] }]), "yes");
  assert.equal(fit([variable("T")], "Object", [{ name: "T", bounds: [number] }]), "no");
  assert.equal(fit([variable("T")], "Object"), "maybe", "a type variable declared out of reach decides nothing");
  assert.equal(fit([variable("T"), ref("int", 0)], "Object, long", [{ name: "T", bounds: [] }]), "no");
  // <T, U extends T>: U erases through T.
  const chain = [{ name: "T", bounds: [] }, { name: "U", bounds: [variable("T")] }];
  assert.equal(fit([variable("U")], "Object", chain), "yes");
  const unresolvedChain = [{ name: "T", bounds: [number] }, { name: "U", bounds: [ref("T", 0)] }];
  assert.equal(fit([variable("U")], "Number", unresolvedChain), "yes", "a bound spelled as an in-scope type variable");
  assert.equal(fit([variable("U")], "Object", unresolvedChain), "no");
  assert.equal(fit([variable("U")], "Object", [{ name: "U", bounds: [variable("U")] }]), "maybe", "a cycle decides nothing");
});

test("isSymbolIdLike routes ids, not names", () => {
  for (const id of ["jsym:mac1:w:k", "jev:mac1:x", "type:v2:a#b", "method:x#y()", "field:x#y", "file:a", "type-local:a:1:1"]) assert.equal(isSymbolIdLike(id), true, id);
  for (const name of ["com.example.Orders", "Orders#place(int)"]) assert.equal(isSymbolIdLike(name), false, name);
});
