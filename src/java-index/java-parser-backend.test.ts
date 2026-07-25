import assert from "node:assert/strict";
import test from "node:test";
import { createJavaParserBackend, type JavaSyntaxNode } from "./java-parser-backend.js";

function findFirst(node: JavaSyntaxNode, type: string): JavaSyntaxNode | undefined {
  if (node.type === type) return node;
  for (const child of node.namedChildren) {
    const found = findFirst(child, type);
    if (found) return found;
  }
  return undefined;
}

test("java parser backend: full parse, incremental edit, changed ranges, delete", async () => {
  const backend = await createJavaParserBackend();
  const source = [
    "package demo;",
    "public class Outer {",
    "  void packagePrivate() {",
    "    String text = \"{not a block}\";",
    "  }",
    "  record Inner(String id) {}",
    "}",
    ""
  ].join("\n");

  const tree = backend.parse(source);
  assert.equal(tree.rootNode.type, "program");
  assert.equal(tree.rootNode.hasError, false);
  assert.match(tree.rootNode.toString(), /method_declaration/);
  assert.match(tree.rootNode.toString(), /record_declaration/);

  const insertToken = "final ";
  const anchor = "String text";
  const charIndex = source.indexOf(anchor);
  // This backend's startIndex/endIndex are UTF-16 code-unit offsets into the
  // JS string (node-tree-sitter hardcodes TSInputEncodingUTF16LE - see the
  // citations in java-parser-backend.ts), not UTF-8 byte offsets, so plain
  // string indices are the correct units for an edit, not Buffer.byteLength.
  const startIndex = charIndex;
  const editedSource = `${source.slice(0, charIndex)}${insertToken}${source.slice(charIndex)}`;

  tree.edit({
    startIndex,
    oldEndIndex: startIndex,
    newEndIndex: startIndex + insertToken.length,
    startPosition: { row: 3, column: 4 },
    oldEndPosition: { row: 3, column: 4 },
    newEndPosition: { row: 3, column: 4 + insertToken.length }
  });
  const updatedTree = backend.parse(editedSource, tree);
  assert.equal(updatedTree.rootNode.hasError, false);

  const changedRanges = tree.getChangedRanges(updatedTree);
  assert.ok(changedRanges.length >= 1);

  const typeNode = findFirst(updatedTree.rootNode, "type_identifier");
  const incrementalTypeText = typeNode
    ? editedSource.slice(typeNode.startIndex, typeNode.endIndex)
    : undefined;
  assert.equal(incrementalTypeText, "String");

  // delete() is a documented no-op for the native backend (see
  // java-parser-backend.ts): calling it must not throw, and the tree must
  // stay usable afterward since native memory is reclaimed by the N-API
  // destructor on GC, not by this call.
  tree.delete();
  updatedTree.delete();
  assert.equal(updatedTree.rootNode.type, "program");
});
