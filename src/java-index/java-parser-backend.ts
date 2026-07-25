import { createRequire } from "node:module";
import Parser from "tree-sitter";

const require = createRequire(import.meta.url);
const Java = require("tree-sitter-java");

// `tree-sitter` (the native N-API binding selected in Task 14) hardcodes
// TSInputEncodingUTF16LE for every parse, regardless of whether the input is
// a plain string or a callback (verified against
// node_modules/tree-sitter/src/parser.cc's CallbackInput::Input() and
// conversions.cc's ByteCountToJS/BYTES_PER_CHARACTER=2). So despite the
// "index"/"byte" naming inherited from tree-sitter's C core, every row/column
// and startIndex/endIndex this backend produces is a 0-based UTF-16 code-unit
// offset into the original JS string - the same units as `String.slice()` and
// `.length`, NOT UTF-8 bytes. `JavaInputEdit` indices must be given in the
// same UTF-16 units. A WASM backend (web-tree-sitter) would be byte-oriented
// instead, so switching backends would require a coordinate-conversion layer
// at this file's boundary, not just a reimplementation of this interface.
export type JavaPoint = { row: number; column: number };

export type JavaInputEdit = {
  startIndex: number;
  oldEndIndex: number;
  newEndIndex: number;
  startPosition: JavaPoint;
  oldEndPosition: JavaPoint;
  newEndPosition: JavaPoint;
};

export interface JavaSyntaxNode {
  readonly type: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: JavaPoint;
  readonly endPosition: JavaPoint;
  readonly namedChildren: readonly JavaSyntaxNode[];
  // Includes anonymous tokens (keywords, punctuation) that `namedChildren`
  // omits - needed for modifier keywords (`public`, `static`, ...) and the
  // `static`/`*` markers on import declarations, none of which are named
  // fields or named nodes in tree-sitter-java's grammar.
  readonly children: readonly JavaSyntaxNode[];
  readonly isNamed: boolean;
  readonly isMissing: boolean;
  readonly hasError: boolean;
  childForFieldName(name: string): JavaSyntaxNode | null;
  toString(): string;
}

export interface JavaSyntaxTree {
  readonly rootNode: JavaSyntaxNode;
  edit(edit: JavaInputEdit): void;
  getChangedRanges(other: JavaSyntaxTree): readonly unknown[];
  delete(): void;
}

export interface JavaParserBackend {
  parse(source: string, oldTree?: JavaSyntaxTree): JavaSyntaxTree;
}

const nativeTrees = new WeakMap<JavaSyntaxTree, Parser.Tree>();

function wrapTree(tree: Parser.Tree): JavaSyntaxTree {
  const wrapped: JavaSyntaxTree = {
    rootNode: tree.rootNode as unknown as JavaSyntaxNode,
    edit(edit: JavaInputEdit): void {
      tree.edit(edit);
    },
    getChangedRanges(other: JavaSyntaxTree): readonly unknown[] {
      const otherNative = nativeTrees.get(other);
      if (!otherNative) throw new Error("getChangedRanges: other tree was not produced by this backend");
      return tree.getChangedRanges(otherNative);
    },
    delete(): void {
      // node-tree-sitter (native) frees the underlying C tree in its N-API
      // destructor when the JS Tree is garbage collected; it never exposes a
      // JS-level Tree.delete() (confirmed by inspecting
      // node_modules/tree-sitter/src/tree.cc — ts_tree_delete() runs in
      // ~Tree(), and only edit/rootNode/rootNodeWithOffset/printDotGraph/
      // getChangedRanges/getIncludedRanges/getEditedRange/_cacheNode/
      // _cacheNodes are registered as InstanceMethods). This is a deliberate
      // no-op, not a dual implementation: it keeps the interface stable for
      // a future WASM backend (web-tree-sitter requires an explicit delete()
      // since Emscripten heap objects aren't covered by V8 GC).
    }
  };
  nativeTrees.set(wrapped, tree);
  return wrapped;
}

class NativeJavaParserBackend implements JavaParserBackend {
  private readonly parser: Parser;

  constructor() {
    this.parser = new Parser();
    this.parser.setLanguage(Java);
  }

  parse(source: string, oldTree?: JavaSyntaxTree): JavaSyntaxTree {
    const previous = oldTree ? nativeTrees.get(oldTree) : undefined;
    if (oldTree && !previous) throw new Error("parse: oldTree was not produced by this backend");
    const tree = this.parser.parse(source, previous);
    return wrapTree(tree);
  }
}

export async function createJavaParserBackend(): Promise<JavaParserBackend> {
  return new NativeJavaParserBackend();
}
