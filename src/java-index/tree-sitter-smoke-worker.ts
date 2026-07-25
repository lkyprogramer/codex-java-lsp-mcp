import { parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
import Parser from "tree-sitter";

const require = createRequire(import.meta.url);
const Java = require("tree-sitter-java");

function findFirst(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | undefined {
  if (node.type === type) return node;
  for (const child of node.namedChildren) {
    const found = findFirst(child, type);
    if (found) return found;
  }
  return undefined;
}

try {
  const parser = new Parser();
  parser.setLanguage(Java);
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
  const tree = parser.parse(source);
  // A same-node-type leaf swap (e.g. "String" -> "Object", both type_identifier)
  // is structurally identical and getChangedRanges correctly reports zero
  // ranges for it (see tree-sitter/tree-sitter discussion #2057) — it only
  // reports where the tree SHAPE differs. Insert a modifier instead, which
  // adds a real `modifiers` child to the local_variable_declaration.
  const insertToken = "final ";
  const anchor = "String text";
  const charIndex = source.indexOf(anchor);
  if (charIndex < 0) throw new Error("smoke edit anchor was not found");
  const startIndex = Buffer.byteLength(source.slice(0, charIndex));
  const editedSource = `${source.slice(0, charIndex)}${insertToken}${source.slice(charIndex)}`;
  tree.edit({
    startIndex,
    oldEndIndex: startIndex,
    newEndIndex: startIndex + Buffer.byteLength(insertToken),
    startPosition: { row: 3, column: 4 },
    oldEndPosition: { row: 3, column: 4 },
    newEndPosition: { row: 3, column: 4 + insertToken.length }
  });
  const updatedTree = parser.parse(editedSource, tree);
  const changedRanges = tree.getChangedRanges(updatedTree);
  const typeNode = findFirst(updatedTree.rootNode, "type_identifier");
  const editedBytes = Buffer.from(editedSource, "utf8");
  const incrementalTypeText = typeNode
    ? editedBytes.subarray(typeNode.startIndex, typeNode.endIndex).toString("utf8")
    : undefined;
  // node-tree-sitter's type declarations do not declare Tree.delete at all
  // (it frees the underlying C tree in its N-API destructor instead), so the
  // presence check goes through an untyped view rather than optional chaining
  // on the declared type.
  type MaybeDeletable = { delete?: () => void };
  const treeDeletable = tree as unknown as MaybeDeletable;
  const updatedTreeDeletable = updatedTree as unknown as MaybeDeletable;
  const supportsDelete = typeof treeDeletable.delete === "function"
    && typeof updatedTreeDeletable.delete === "function";
  parentPort?.postMessage({
    ok: true,
    rootType: updatedTree.rootNode.type,
    hasError: updatedTree.rootNode.hasError,
    text: updatedTree.rootNode.toString(),
    changedRanges: changedRanges.length,
    incrementalTypeText,
    supportsDelete
  });
  treeDeletable.delete?.();
  updatedTreeDeletable.delete?.();
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.stack : String(error)
  });
}
